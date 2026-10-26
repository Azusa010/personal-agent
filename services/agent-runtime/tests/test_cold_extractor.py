"""Step 5 单元与集成测试网：带 NO_OP 过滤的后台冷记忆提炼器（Cold Memory Extractor）。

核心业务验证：
1. 提炼数据契约：CandidateMemoryItem 与 ExtractionResult 字段校验、Pydantic 序列化/反序列化；
2. 提取游标单调性与断点持久化：ExtractorCursor 记录 last_extracted_seq_id，支持落盘与恢复，防倒流；
3. 暂存信箱纯追加：MemoryInbox 严格追加写 inbox.jsonl，保证 UTF-8 编码与 JSONL 格式；
4. 强噪音过滤与 NO_OP 判定：对短轮次寒暄、命令报错、ephemeral 瞬态事件直接过滤，不产生脏数据；
5. 核心提炼逻辑与置信度把关：成功提炼高价值偏好/决策事实，低置信度与 NO_OP 条目不落盘；
6. 批量消费与 Drain 循环：支持按 batch_size 分块消费，drain_all 一键清空未消费事件队列；
7. 断点续提防重提：服务重启加载既有游标，只消费增量事件，绝不重复提取；
8. 并发提炼防竞态：多线程并发调用 extract_next_batch 时严格串行互斥，无重复写入与游标撕裂。
"""

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from personal_agent.conversation.extractor import (
    CandidateMemoryItem,
    ColdMemoryExtractor,
    ExtractionAction,
    ExtractionResult,
    ExtractorCursor,
    MemoryCategory,
    MemoryInbox,
    is_noise_event,
)
from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger


@pytest.fixture
def temp_dir(tmp_path: Path) -> Path:
    """提供纯净的测试目录。"""
    return tmp_path


@pytest.fixture
def ledger(temp_dir: Path) -> MainEventLedger:
    """初始化用于测试的主事件账本。"""
    log_file = temp_dir / "logs" / "main_session_events.jsonl"
    return MainEventLedger(log_file=log_file)


@pytest.fixture
def inbox(temp_dir: Path) -> MemoryInbox:
    """初始化暂存信箱。"""
    inbox_file = temp_dir / "memory" / "inbox.jsonl"
    return MemoryInbox(inbox_file=inbox_file)


@pytest.fixture
def cursor(temp_dir: Path) -> ExtractorCursor:
    """初始化提取游标。"""
    cursor_file = temp_dir / "memory" / "extractor_cursor.json"
    return ExtractorCursor(cursor_file=cursor_file)


def test_models_serialization():
    """测试提炼条目与结果模型的 Schema 契约与序列化。"""
    action: ExtractionAction = "STORE"
    category: MemoryCategory = "user_profile"
    item = CandidateMemoryItem(
        id="item-001",
        action=action,
        category=category,
        content="用户强制要求所有 Python 代码使用 4 空格缩进，禁止使用 Tab",
        confidence=0.98,
        source_seq_range=(1, 3),
        extracted_at="2026-10-15T22:30:00Z",
        status="pending",
    )
    raw_json = item.model_dump_json()
    assert "item-001" in raw_json
    assert "user_profile" in raw_json

    restored = CandidateMemoryItem.model_validate_json(raw_json)
    assert restored.id == item.id
    assert restored.action == "STORE"
    assert restored.confidence == 0.98
    assert tuple(restored.source_seq_range) == (1, 3)
    assert restored.status == "pending"

    result = ExtractionResult(
        items=[item],
        processed_events_count=3,
        from_seq_id=1,
        to_seq_id=3,
        noop_count=0,
    )
    assert len(result.items) == 1
    assert result.processed_events_count == 3
    assert result.to_seq_id == 3


def test_cursor_advance_persistence_and_no_rollback(temp_dir: Path):
    """测试提取游标的初值、推进、磁盘持久化以及防倒退机制。"""
    cursor_file = temp_dir / "memory" / "extractor_cursor.json"
    cursor = ExtractorCursor(cursor_file=cursor_file)

    # 初始游标为 0
    assert cursor.last_extracted_seq_id == 0

    # 推进到 10
    cursor.advance(10)
    assert cursor.last_extracted_seq_id == 10
    assert cursor_file.exists()

    # 从磁盘重载验证持久化
    new_cursor = ExtractorCursor(cursor_file=cursor_file)
    assert new_cursor.last_extracted_seq_id == 10

    # 防倒退机制：若传入更小的序号，必须拒绝或保持最大值，绝不能倒流
    new_cursor.advance(5)
    assert new_cursor.last_extracted_seq_id == 10

    # 继续正向推进到 25
    new_cursor.advance(25)
    assert new_cursor.last_extracted_seq_id == 25


def test_memory_inbox_append_and_read(inbox: MemoryInbox):
    """测试暂存信箱的追加写入、UTF-8 中文保证以及状态读取。"""
    assert inbox.count_pending() == 0

    item1 = CandidateMemoryItem(
        id="item-1",
        action="STORE",
        category="project_context",
        content="生产代码全由主人亲手编写，AI 仅出规格与测试网",
        confidence=1.0,
        source_seq_range=(1, 2),
        extracted_at="2026-10-15T22:31:00Z",
    )
    item2 = CandidateMemoryItem(
        id="item-2",
        action="STORE",
        category="coding_standards",
        content="持久化层禁止硬编码 switch-case，统一采用自描述插件架构",
        confidence=0.95,
        source_seq_range=(3, 5),
        extracted_at="2026-10-15T22:32:00Z",
    )

    inbox.append(item1)
    inbox.append(item2)

    assert inbox.count_pending() == 2
    pending = inbox.read_pending()
    assert len(pending) == 2
    assert pending[0].id == "item-1"
    assert "主人亲手编写" in pending[0].content
    assert pending[1].id == "item-2"
    assert "自描述插件架构" in pending[1].content

    # 验证底层文件内容为规范 JSONL 且为 UTF-8
    lines = inbox.inbox_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    parsed_first = json.loads(lines[0])
    assert parsed_first["id"] == "item-1"


def test_noise_detection_heuristics():
    """测试启发式强噪音探测函数对纯垃圾、临时探查与报错的识别。"""
    # 瞬态 ephemeral 事件
    ephemeral_event = LedgerEvent(
        seq_id=1,
        epoch_id=1,
        timestamp="1000",
        event_type="user",
        payload={"text": "heartbeat"},
        token_count=5,
        ephemeral=True,
    )
    assert is_noise_event(ephemeral_event) is True

    # 报错与堆栈日志
    error_event = LedgerEvent(
        seq_id=2,
        epoch_id=1,
        timestamp="1001",
        event_type="tool_result",
        payload={"error": "FileNotFoundError: [Errno 2] No such file or directory: 'temp.log'"},
        token_count=15,
    )
    assert is_noise_event(error_event) is True

    # 纯寒暄
    greeting_event = LedgerEvent(
        seq_id=3,
        epoch_id=1,
        timestamp="1002",
        event_type="user",
        payload={"text": "你好啊"},
        token_count=3,
    )
    assert is_noise_event(greeting_event) is True

    # 包含高价值架构信息的事件，绝不是噪音
    valuable_event = LedgerEvent(
        seq_id=4,
        epoch_id=1,
        timestamp="1003",
        event_type="user",
        payload={"text": "请记住，本项目统一使用 Vitest，严禁再使用 Jest"},
        token_count=20,
    )
    assert is_noise_event(valuable_event) is False


def test_extractor_extracts_valuable_memory(ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor):
    """测试提炼器提取真实高价值信息并写入 inbox，游标同步前移。"""
    e1 = ledger.append_event("user", {"text": "我的数据库密码要求至少16位，并且只跑在内网端口 5432"})
    e2 = ledger.append_event("assistant", {"text": "已明确收到数据库安全要求。"})
    assert e1.seq_id < e2.seq_id

    # 模拟提取函数：针对包含数据库的轮次提取出偏好事实
    def mock_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        full_text = " ".join([str(e.payload.get("text", "")) for e in events])
        if "数据库" in full_text:
            return [
                CandidateMemoryItem(
                    id="mock-1",
                    action="STORE",
                    category="project_context",
                    content="数据库要求：密码至少16位，仅限内网 5432 端口",
                    confidence=0.99,
                    source_seq_range=(events[0].seq_id, events[-1].seq_id),
                    extracted_at="2026-10-15T22:33:00Z",
                )
            ]
        return []

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract_fn,
        batch_size=10,
    )

    result = extractor.extract_next_batch()
    assert result.processed_events_count == 2
    assert result.to_seq_id == e2.seq_id
    assert len(result.items) == 1
    assert result.items[0].content == "数据库要求：密码至少16位，仅限内网 5432 端口"

    # 验证游标推进
    assert cursor.last_extracted_seq_id == e2.seq_id

    # 验证 inbox 写入
    pending = inbox.read_pending()
    assert len(pending) == 1
    assert pending[0].id == "mock-1"


def test_extractor_noop_filtering(ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor):
    """测试当批次全为噪音或提取函数返回 NO_OP 时，不写入 inbox 但正常推进游标。"""
    # 灌入纯噪音事件
    e1 = ledger.append_event("user", {"text": "hi"})
    e2 = ledger.append_event("assistant", {"text": "hello! how can i help?"})
    assert e1.seq_id < e2.seq_id

    # 模拟返回 NO_OP 的提取函数
    def mock_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        return [
            CandidateMemoryItem(
                id="noop-1",
                action="NO_OP",
                category="other",
                content="",
                confidence=0.95,
                source_seq_range=(events[0].seq_id, events[-1].seq_id),
                extracted_at="2026-10-15T22:34:00Z",
            )
        ]

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract_fn,
        batch_size=10,
    )

    result = extractor.extract_next_batch()
    assert result.processed_events_count == 2
    assert len(result.items) == 0  # NO_OP 必须被过滤
    assert result.noop_count >= 1

    # inbox 保持绝对干净
    assert inbox.count_pending() == 0

    # 游标正常前进至 e2
    assert cursor.last_extracted_seq_id == e2.seq_id


def test_extractor_all_noise_batch_returns_empty_items(
    ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor
):
    """整批事件在进入提炼函数前就被判为噪音时，仍要返回合法的 ExtractionResult。

    回归：该分支曾漏填必填字段 items，导致 Pydantic 校验抛错，
    把整条长程记忆流水线（提炼 + 做梦）打断。
    """
    e1 = ledger.append_event("user", {"text": "你好"})
    e2 = ledger.append_event("assistant", {"text": "谢谢", "error": "temporary"})
    assert e1.seq_id < e2.seq_id

    extract_fn_called = False

    def mock_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        nonlocal extract_fn_called
        extract_fn_called = True
        return []

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract_fn,
        batch_size=10,
    )

    result = extractor.extract_next_batch()

    assert extract_fn_called is False  # 全噪音批次不该浪费模型调用
    assert result.items == []
    assert result.processed_events_count == 2
    assert result.noop_count == 2
    assert result.from_seq_id == e1.seq_id
    assert result.to_seq_id == e2.seq_id
    # 游标正常前进，inbox 保持干净
    assert cursor.last_extracted_seq_id == e2.seq_id
    assert inbox.count_pending() == 0


def test_extractor_confidence_threshold_filtering(ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor):
    """测试低置信度条目被过滤拦截，不进入 inbox。"""
    e1 = ledger.append_event("user", {"text": "也许我们以后可以试试别的工具吧"})

    def mock_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        return [
            CandidateMemoryItem(
                id="low-conf-1",
                action="STORE",
                category="other",
                content="用户可能想要换工具",
                confidence=0.40,  # 低于默认 min_confidence=0.70
                source_seq_range=(e1.seq_id, e1.seq_id),
                extracted_at="2026-10-15T22:35:00Z",
            )
        ]

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract_fn,
        min_confidence=0.70,
    )

    result = extractor.extract_next_batch()
    assert result.processed_events_count == 1
    assert len(result.items) == 0  # 40% 置信度被拦截
    assert inbox.count_pending() == 0
    assert cursor.last_extracted_seq_id == e1.seq_id


def test_batching_and_drain_all(ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor):
    """测试按 batch_size 分块消费，以及 drain_all 一次性消化整库。"""
    # 写入 25 条事件
    for i in range(1, 26):
        ledger.append_event("user", {"text": f"第 {i} 条记录信息，包含 key_{i}"})

    def mock_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        # 偶数批次提取一个条目
        first_seq = events[0].seq_id
        if first_seq % 2 == 0:
            return [
                CandidateMemoryItem(
                    id=f"item-batch-{first_seq}",
                    action="STORE",
                    category="other",
                    content=f"批次起始序号为偶数: {first_seq}",
                    confidence=0.9,
                    source_seq_range=(events[0].seq_id, events[-1].seq_id),
                    extracted_at="2026-10-15T22:36:00Z",
                )
            ]
        return []

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract_fn,
        batch_size=10,  # 25条记录需要 3 批：10, 10, 5
    )

    results = extractor.drain_all(max_batches=10)
    assert len(results) == 3
    assert results[0].processed_events_count == 10
    assert results[1].processed_events_count == 10
    assert results[2].processed_events_count == 5

    # 游标彻底对齐 25
    assert cursor.last_extracted_seq_id == 25

    # 再次执行 drain_all 应无新事件处理
    empty_results = extractor.drain_all(max_batches=5)
    assert len(empty_results) == 0


def test_resume_from_cursor_avoids_duplicate_extraction(ledger: MainEventLedger, inbox: MemoryInbox, temp_dir: Path):
    """测试断点恢复续提：重启后读取现有游标，绝不重复提取已处理事件。"""
    cursor_file = temp_dir / "memory" / "extractor_cursor.json"

    # 先产生 10 条事件
    for i in range(1, 11):
        ledger.append_event("user", {"text": f"前置事件 {i}"})

    # 先前已经处理到 seq_id = 10，并持久化到文件
    pre_cursor = ExtractorCursor(cursor_file=cursor_file)
    pre_cursor.advance(10)

    # 账本追加 3 条新事件 (seq_id 11, 12, 13)
    e11 = ledger.append_event("user", {"text": "新增事件 11"})
    e12 = ledger.append_event("user", {"text": "新增事件 12"})
    e13 = ledger.append_event("user", {"text": "新增事件 13"})
    assert (e11.seq_id, e12.seq_id, e13.seq_id) == (11, 12, 13)

    processed_seqs: list[int] = []

    def tracking_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        for e in events:
            processed_seqs.append(e.seq_id)
        return []

    # 重启实例化 Extractor，注入加载了磁盘游标的对象
    reloaded_cursor = ExtractorCursor(cursor_file=cursor_file)
    assert reloaded_cursor.last_extracted_seq_id == 10

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=reloaded_cursor,
        extract_fn=tracking_extract_fn,
        batch_size=10,
    )

    result = extractor.extract_next_batch()
    # 严格只处理了 11, 12, 13，绝不重复处理 1~10
    assert processed_seqs == [11, 12, 13]
    assert result.from_seq_id == 11
    assert result.to_seq_id == 13
    assert reloaded_cursor.last_extracted_seq_id == 13


def test_concurrent_extraction_safety(ledger: MainEventLedger, inbox: MemoryInbox, cursor: ExtractorCursor):
    """测试多线程并发触发提炼时的线程安全与互斥锁保护，防止游标撕裂或重复提取。"""
    for i in range(1, 31):
        ledger.append_event("user", {"text": f"并发测试事件 {i}"})

    extracted_item_ids: list[str] = []

    def thread_safe_extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        # 为每批事件生成唯一条目
        item_id = f"item-{events[0].seq_id}-{events[-1].seq_id}"
        extracted_item_ids.append(item_id)
        return [
            CandidateMemoryItem(
                id=item_id,
                action="STORE",
                category="other",
                content=f"提取了从 {events[0].seq_id} 到 {events[-1].seq_id} 的事件",
                confidence=0.95,
                source_seq_range=(events[0].seq_id, events[-1].seq_id),
                extracted_at="2026-10-15T22:37:00Z",
            )
        ]

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=thread_safe_extract_fn,
        batch_size=5,  # 30 条事件共 6 批
    )

    # 启动 4 个并发线程争抢调用 extract_next_batch
    def worker():
        for _ in range(3):
            extractor.extract_next_batch()

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(worker) for _ in range(4)]
        for f in futures:
            f.result()

    # 验证全部 30 条事件被刚好消费，游标对齐 30
    assert cursor.last_extracted_seq_id == 30

    # 验证 inbox 中没有重复的条目
    pending = inbox.read_pending()
    assert len(pending) == 6
    unique_ids = {p.id for p in pending}
    assert len(unique_ids) == 6
