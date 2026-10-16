"""Step 6 单元与集成测试网：基于文件重命名锁的自动 /dream 归并引擎（Dream Consolidation Engine）。

核心业务验证：
1. 数据契约校验：DreamRequest 与 DreamResult 的 Pydantic 序列化、反序列化与 extra 字段宽容；
2. 原子重命名锁机制：AtomicRenameLock 负责 inbox.jsonl -> inbox.lock.jsonl 的瞬时切换与释放；
3. 锁防重与空转防护：当信箱为空或已有进行中的 dream 任务时，加锁安全返回 False，杜绝死锁与空转；
4. 常驻索引编译器：IndexCompiler 从 topics/*.md 提炼标题与摘要，原子更新生成 INDEX.md；
5. 索引空目录容错：无持久化主题时，IndexCompiler 安全生成兜底轻量占位索引；
6. 阈值触发与强制唤醒：积压条目不足 min_pending_items 时拒绝触发，force=True 时强制唤醒归并；
7. 零锁竞争（生产者并发追加）：在 Dream 消费 lock 文件期间，上游 MemoryInbox 可持续并发无阻写入新 inbox.jsonl；
8. 7大分类多主题聚合归并：将候选条目按 category 正交分流，调用 consolidate_fn 合并已有知识并原子落盘；
9. 原子覆写抗崩溃保障：主题文件与 INDEX.md 均经由 .tmp 临时文件与 os.replace 刷盘，杜绝截断脏数据；
10. 并发互斥与防重复归并：多线程并发调用 run_dream 时互斥竞争，仅单次成功执行，无游标撕裂或重复归并。
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from personal_agent.conversation.dream import (
    AtomicRenameLock,
    DreamEngine,
    DreamRequest,
    DreamResult,
    IndexCompiler,
)
from personal_agent.conversation.extractor import (
    CandidateMemoryItem,
    MemoryInbox,
)


@pytest.fixture
def temp_memory_dir(tmp_path: Path) -> Path:
    """提供纯净的 memory 工作目录。"""
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    return mem_dir


@pytest.fixture
def sample_candidate_items() -> list[CandidateMemoryItem]:
    """生成包含多个分类的标准候选记忆条目。"""
    return [
        CandidateMemoryItem(
            id="cand-001",
            action="STORE",
            category="user_profile",
            content="主人喜欢使用暗色主题与 14px 宽屏等宽字体",
            confidence=0.99,
            source_seq_range=(1, 3),
            extracted_at="2026-10-16T10:00:00Z",
        ),
        CandidateMemoryItem(
            id="cand-002",
            action="STORE",
            category="coding_standards",
            content="生产代码全由主人亲手编写，AI 仅出规格与测试网",
            confidence=1.0,
            source_seq_range=(4, 6),
            extracted_at="2026-10-16T10:01:00Z",
        ),
        CandidateMemoryItem(
            id="cand-003",
            action="STORE",
            category="coding_standards",
            content="所有文件统一使用 UTF-8 编码，严禁平台 ANSI 乱码",
            confidence=0.95,
            source_seq_range=(7, 8),
            extracted_at="2026-10-16T10:02:00Z",
        ),
        CandidateMemoryItem(
            id="cand-004",
            action="STORE",
            category="project_context",
            content="Agent Runtime 采用 Python 3.12 与 Pydantic V2 构建",
            confidence=0.98,
            source_seq_range=(9, 10),
            extracted_at="2026-10-16T10:03:00Z",
        ),
        CandidateMemoryItem(
            id="cand-005",
            action="STORE",
            category="key_decision",
            content="采用基于原子重命名锁的无竞争日志归并架构",
            confidence=0.97,
            source_seq_range=(11, 12),
            extracted_at="2026-10-16T10:04:00Z",
        ),
    ]


def test_dream_models_schema_and_serialization():
    """1. 测试 DreamRequest 与 DreamResult 的模型校验、默认值与额外字段宽容。"""
    # 默认请求
    req_default = DreamRequest()
    assert req_default.force is False
    assert req_default.min_pending_items == 5

    # 自定义请求（支持 extra 字段扩展）
    req_custom = DreamRequest(
        force=True,
        min_pending_items=10,
        trigger_source="manual_slash_command",
    )
    assert req_custom.force is True
    assert req_custom.min_pending_items == 10
    assert req_custom.model_dump().get("trigger_source") == "manual_slash_command"

    # 归并结果模型
    result = DreamResult(
        success=True,
        consolidated_items_count=5,
        categories_updated=["user_profile", "coding_standards"],
        index_rebuilt=True,
        message="Dream consolidation completed successfully",
        lock_file_path="/tmp/memory/inbox.lock.jsonl",
        extra_meta={"latency_ms": 120},
    )
    raw_json = result.model_dump_json()
    assert "user_profile" in raw_json
    assert "coding_standards" in raw_json

    restored = DreamResult.model_validate_json(raw_json)
    assert restored.success is True
    assert restored.consolidated_items_count == 5
    assert len(restored.categories_updated) == 2
    assert restored.index_rebuilt is True
    assert restored.model_dump().get("extra_meta") == {"latency_ms": 120}


def test_atomic_rename_lock_lifecycle(temp_memory_dir: Path):
    """2. 测试 AtomicRenameLock 的加锁、改名隔离以及最终释放清理生命周期。"""
    inbox_file = temp_memory_dir / "inbox.jsonl"
    lock_file = temp_memory_dir / "inbox.lock.jsonl"

    # 准备初始信箱内容
    inbox_file.write_text('{"id": "1", "content": "test"}\n', encoding="utf-8")
    assert inbox_file.exists()
    assert not lock_file.exists()

    lock = AtomicRenameLock(inbox_file=inbox_file, lock_file=lock_file)
    assert not lock.is_locked()

    # 尝试加锁：应当成功将 inbox.jsonl 重命名为 inbox.lock.jsonl
    acquired = lock.try_acquire()
    assert acquired is True
    assert lock.is_locked()
    assert not inbox_file.exists()
    assert lock_file.exists()

    # 锁持有期间内容完整未损坏
    assert '{"id": "1", "content": "test"}' in lock_file.read_text(encoding="utf-8")

    # 释放锁：删除 lock_file
    lock.release()
    assert not lock.is_locked()
    assert not lock_file.exists()


def test_atomic_rename_lock_busy_and_empty_protection(temp_memory_dir: Path):
    """3. 测试原子重命名锁在文件不存在、内容为空或已有锁竞争时的安全防御。"""
    inbox_file = temp_memory_dir / "inbox.jsonl"
    lock_file = temp_memory_dir / "inbox.lock.jsonl"
    lock = AtomicRenameLock(inbox_file=inbox_file, lock_file=lock_file)

    # 场景 A: inbox 文件尚不存在，直接加锁应返回 False，绝不崩溃
    assert lock.try_acquire() is False

    # 场景 B: inbox 文件存在但为 0 字节空文件，无需归并，返回 False
    inbox_file.touch()
    assert lock.try_acquire() is False

    # 场景 C: lock_file 已被占用（模拟其他进程正在归并），加锁必须被拒绝
    inbox_file.write_text('{"id": "2"}\n', encoding="utf-8")
    lock_file.write_text('{"id": "1"}\n', encoding="utf-8")  # 占用锁
    assert lock.try_acquire() is False
    # 原 inbox 文件仍被安全保留，不受破坏
    assert inbox_file.exists()

    # 清理释放后即可成功
    lock.release()
    assert lock.try_acquire() is True
    assert not inbox_file.exists()
    assert lock_file.exists()
    lock.release()


def test_index_compiler_with_topics(temp_memory_dir: Path):
    """4. 测试 IndexCompiler 解析 topics/*.md 并原子重编译生成 INDEX.md 索引。"""
    topics_dir = temp_memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)

    # 编写两个规范主题 Markdown 文件
    (topics_dir / "user_profile.md").write_text(
        "# 主人个人画像 (User Profile)\n\n全栈架构师，偏好 Python 3.12 与 TypeScript。\n- 编辑器：VS Code\n",
        encoding="utf-8",
    )
    (topics_dir / "coding_standards.md").write_text(
        "# 工程编码规范 (Coding Standards)\n\n所有业务代码必须由主人亲手编写，严禁 AI 擅自代写。\n",
        encoding="utf-8",
    )

    compiler = IndexCompiler(memory_dir=temp_memory_dir)
    compiled_index = compiler.recompile()

    # 验证返回内容与磁盘文件
    index_file = temp_memory_dir / "INDEX.md"
    assert index_file.exists()
    disk_content = index_file.read_text(encoding="utf-8")
    assert disk_content == compiled_index

    # 验证包含主题条目与提炼摘要
    assert "- [user_profile.md]" in disk_content
    assert "主人个人画像" in disk_content or "全栈架构师" in disk_content
    assert "- [coding_standards.md]" in disk_content
    assert "工程编码规范" in disk_content or "所有业务代码" in disk_content

    # 验证零脏文件残留
    assert not (temp_memory_dir / "INDEX.md.tmp").exists()


def test_index_compiler_empty_directory(temp_memory_dir: Path):
    """5. 测试 IndexCompiler 在 topics 目录为空或不存在时的安全兜底。"""
    compiler = IndexCompiler(memory_dir=temp_memory_dir)
    compiled_index = compiler.recompile()

    index_file = temp_memory_dir / "INDEX.md"
    assert index_file.exists()
    assert "长期记忆索引库" in compiled_index
    # 不产生任何致命异常，包含空状态占位提示
    assert len(compiled_index) > 0


def test_dream_engine_threshold_trigger(
    temp_memory_dir: Path,
    sample_candidate_items: list[CandidateMemoryItem],
):
    """6. 测试 DreamEngine 阈值门禁：低于阈值时不触发，force=True 或达到阈值时触发。"""
    inbox = MemoryInbox(inbox_file=temp_memory_dir / "inbox.jsonl")
    # 仅追加 3 条记录（默认阈值 5）
    inbox.append_batch(sample_candidate_items[:3])

    engine = DreamEngine(
        memory_dir=temp_memory_dir,
        inbox=inbox,
        default_min_items=5,
    )

    # 场景 A: 默认未达到阈值，拒绝触发归并
    res_rejected = engine.run_dream(DreamRequest(force=False, min_pending_items=5))
    assert res_rejected.success is False
    assert res_rejected.consolidated_items_count == 0
    assert (
        "below threshold" in res_rejected.message.lower()
        or "insufficient" in res_rejected.message.lower()
        or "not enough" in res_rejected.message.lower()
    )
    # 信箱里的 3 条数据依然完好无损
    assert inbox.count_pending() == 3

    # 场景 B: force=True 强制触发归并
    res_forced = engine.run_dream(DreamRequest(force=True))
    assert res_forced.success is True
    assert res_forced.consolidated_items_count == 3
    assert len(res_forced.categories_updated) > 0
    assert res_forced.index_rebuilt is True
    # 信箱已被完全消费清空
    assert inbox.count_pending() == 0


def test_dream_engine_zero_contention_concurrent_producer(
    temp_memory_dir: Path,
    sample_candidate_items: list[CandidateMemoryItem],
):
    """7. 测试无锁竞争核心机制：在 Dream 归并处理期间，上游 Extractor 追加写新数据绝不阻塞且不丢失。"""
    inbox_file = temp_memory_dir / "inbox.jsonl"
    inbox = MemoryInbox(inbox_file=inbox_file)
    inbox.append_batch(sample_candidate_items)
    assert inbox.count_pending() == 5

    # 模拟耗时归并函数
    def slow_consolidate_fn(
        category: str,
        existing: str,
        items: list[CandidateMemoryItem],
    ) -> str:
        time.sleep(0.2)  # 模拟大模型推理延迟
        bullet_points = "\n".join(f"- {item.content}" for item in items if item.content)
        return f"# {category.upper()}\n\n{bullet_points}\n"

    engine = DreamEngine(
        memory_dir=temp_memory_dir,
        inbox=inbox,
        consolidate_fn=slow_consolidate_fn,
    )

    # 在单独线程启动 Dream 归并
    dream_future = None
    with ThreadPoolExecutor(max_workers=2) as executor:
        dream_future = executor.submit(engine.run_dream, DreamRequest(force=True))

        # 等待 Dream 取得锁并移走原 inbox.jsonl
        time.sleep(0.05)

        # 此时 Dream 正在运行，外部生产者并发追加 2 条新条目
        new_item_1 = CandidateMemoryItem(
            id="cand-new-001",
            action="STORE",
            category="user_profile",
            content="用户偏好在晚上 22:00 之后进行深度代码重构",
            confidence=0.96,
            source_seq_range=(100, 101),
            extracted_at="2026-10-16T10:10:00Z",
        )
        new_item_2 = CandidateMemoryItem(
            id="cand-new-002",
            action="STORE",
            category="project_context",
            content="系统架构演进至 Step 6 归并引擎阶段",
            confidence=0.99,
            source_seq_range=(102, 103),
            extracted_at="2026-10-16T10:11:00Z",
        )

        # 验证写入顺畅完成（无锁阻塞，直接产生全新的 inbox.jsonl）
        inbox.append(new_item_1)
        inbox.append(new_item_2)

        # 等待 Dream 归并完全结束
        result = dream_future.result()

    assert result.success is True
    assert result.consolidated_items_count == 5

    # 核心断言：先前归并的 5 条已被消费，而并发写入的 2 条新条目安全留存在当前 inbox.jsonl 中！
    assert inbox.count_pending() == 2
    pending_items = inbox.read_pending()
    assert {p.id for p in pending_items} == {"cand-new-001", "cand-new-002"}


def test_dream_engine_multi_category_consolidation(
    temp_memory_dir: Path,
    sample_candidate_items: list[CandidateMemoryItem],
):
    """8. 测试 7 大分类多主题分流归并，与既有 Markdown 内容合并不丢历史。"""
    inbox = MemoryInbox(inbox_file=temp_memory_dir / "inbox.jsonl")
    inbox.append_batch(sample_candidate_items)

    # 预设已有的 user_profile.md
    topics_dir = temp_memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)
    existing_user_profile = "# USER PROFILE\n\n- 常用语言：Rust/Python/TS\n"
    (topics_dir / "user_profile.md").write_text(existing_user_profile, encoding="utf-8")

    def mock_consolidate_fn(
        category: str,
        existing: str,
        items: list[CandidateMemoryItem],
    ) -> str:
        header = existing.strip() if existing.strip() else f"# {category.upper()}"
        new_bullets = "\n".join(f"- {item.content}" for item in items if item.content)
        return f"{header}\n{new_bullets}\n"

    engine = DreamEngine(
        memory_dir=temp_memory_dir,
        inbox=inbox,
        consolidate_fn=mock_consolidate_fn,
    )

    result = engine.run_dream(DreamRequest(force=True))
    assert result.success is True
    assert result.consolidated_items_count == 5

    # 验证分类更新集合涵盖：user_profile, coding_standards, project_context, key_decision
    assert "user_profile" in result.categories_updated
    assert "coding_standards" in result.categories_updated
    assert "project_context" in result.categories_updated
    assert "key_decision" in result.categories_updated

    # 验证 user_profile.md 既包含历史内容，又追加了新事实
    updated_user_profile = (topics_dir / "user_profile.md").read_text(encoding="utf-8")
    assert "常用语言：Rust/Python/TS" in updated_user_profile
    assert "暗色主题" in updated_user_profile

    # 验证 coding_standards.md 包含两条新规
    updated_coding_standards = (topics_dir / "coding_standards.md").read_text(encoding="utf-8")
    assert "生产代码全由主人亲手编写" in updated_coding_standards
    assert "UTF-8 编码" in updated_coding_standards

    # 验证 INDEX.md 被同步刷新且包含对应条目
    index_content = (temp_memory_dir / "INDEX.md").read_text(encoding="utf-8")
    assert "user_profile.md" in index_content
    assert "coding_standards.md" in index_content


def test_dream_engine_atomic_write_crash_resilience(
    temp_memory_dir: Path,
    sample_candidate_items: list[CandidateMemoryItem],
):
    """9. 测试原子写与抗崩溃机制：所有落盘严格通过 .tmp 缓冲后 replace，不留残缺半成品。"""
    inbox = MemoryInbox(inbox_file=temp_memory_dir / "inbox.jsonl")
    inbox.append_batch(sample_candidate_items)

    topics_dir = temp_memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)

    engine = DreamEngine(memory_dir=temp_memory_dir, inbox=inbox)
    result = engine.run_dream(DreamRequest(force=True))
    assert result.success is True

    # 验证 topics 目录下没有任何 .tmp 文件遗留
    tmp_files = list(topics_dir.glob("*.tmp"))
    assert len(tmp_files) == 0

    # 验证 memory 根目录下没有任何 INDEX.md.tmp 或 inbox.lock.jsonl 遗留
    assert not (temp_memory_dir / "INDEX.md.tmp").exists()
    assert not (temp_memory_dir / "inbox.lock.jsonl").exists()


def test_dream_engine_concurrent_dream_calls_mutex(
    temp_memory_dir: Path,
    sample_candidate_items: list[CandidateMemoryItem],
):
    """10. 测试并发互斥：多个线程同时发起 run_dream 调度时，仅有一个线程能获取锁，其余平稳返回不崩溃。"""
    inbox = MemoryInbox(inbox_file=temp_memory_dir / "inbox.jsonl")
    inbox.append_batch(sample_candidate_items)

    def slow_consolidate(category: str, existing: str, items: list[CandidateMemoryItem]) -> str:
        time.sleep(0.15)
        return f"# {category}\n- consolidated\n"

    engine = DreamEngine(
        memory_dir=temp_memory_dir,
        inbox=inbox,
        consolidate_fn=slow_consolidate,
    )

    results: list[DreamResult] = []
    lock = threading.Lock()

    def run_worker():
        res = engine.run_dream(DreamRequest(force=True))
        with lock:
            results.append(res)

    # 4 个并发线程争抢执行 dream
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(run_worker) for _ in range(4)]
        for f in futures:
            f.result()

    assert len(results) == 4
    # 刚好只有 1 个成功获取锁并完成了归并
    successful_runs = [r for r in results if r.success is True]
    rejected_runs = [r for r in results if r.success is False]

    assert len(successful_runs) == 1
    assert successful_runs[0].consolidated_items_count == 5
    assert len(rejected_runs) == 3

    # 所有拒绝原因均表明锁繁忙或信箱已空
    for rej in rejected_runs:
        assert rej.consolidated_items_count == 0
        assert "lock" in rej.message.lower() or "empty" in rej.message.lower() or "busy" in rej.message.lower()

    # 最终信箱为空，锁文件被清理
    assert inbox.count_pending() == 0
    assert not (temp_memory_dir / "inbox.lock.jsonl").exists()
