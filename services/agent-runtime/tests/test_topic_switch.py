"""Step 4 单元与集成测试网：180度转弯话题切换协议与三层漏斗并联召回。

覆盖业务场景：
1. 话题切换：归档当前 Epoch 现场到 Markdown，并自增 current_epoch_id；
2. 水印瞬移：window_watermark 跃迁至新话题前夕，彻底从活跃窗口剥离旧任务万级 Token；
3. 滚动摘要重置：旧任务 rolling_task_summary 被即时清空或重置为新任务意图；
4. 三层召回漏斗：
   - Tier 1: System Prompt 零成本常驻 INDEX.md 读取；
   - Tier 2: read_memory_topic 显式定向读取长期记忆 Markdown；
   - Tier 3: search_raw_events 委托 Step 1 原始账本翻旧账；
5. 并联调度器：同轮并发 Tool Calls 时优先执行话题切换，确保因果顺序与洁净上下文；
6. 边界与健壮性：空活跃窗口话题切换、不存在的记忆主题容错、Schema 校验。
"""

from pathlib import Path

import pytest

from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.topics import (
    ParallelRecallCoordinator,
    ParallelToolCall,
    ThreeTierRetriever,
    TopicSwitchHandler,
    TopicSwitchRequest,
    TopicSwitchResult,
)
from personal_agent.conversation.windows import SlidingWindowLedger, WindowConfig


def _seed_topic_events(
    ledger: MainEventLedger,
    topic_name: str = "微信支付排错",
    num_turns: int = 5,
    tokens_per_event: int = 1500,
) -> list[LedgerEvent]:
    """向账本灌入指定主题的多轮对话事件，累积较大 Token 模拟活跃上下文。"""
    events: list[LedgerEvent] = []
    base_ts = 1_700_000_000.0

    for i in range(1, num_turns + 1):
        ts = base_ts + i * 60.0
        # User event
        u_event = ledger.append_event(
            event_type="user",
            content=f"[{topic_name}] 第 {i} 轮提问：请检查支付回调验签逻辑",
            token_count=tokens_per_event,
            timestamp=ts,
        )
        events.append(u_event)

        # Assistant tool call
        call_event = ledger.append_event(
            event_type="tool_call",
            content=f'{{"tool": "query_logs", "arg": "order_id_{i}"}}',
            tool_call_id=f"call_{i}",
            token_count=tokens_per_event,
            timestamp=ts + 2.0,
        )
        events.append(call_event)

        # Tool result
        res_event = ledger.append_event(
            event_type="tool_result",
            content=f'{{"status": "ok", "order": {i}, "verified": false}}',
            tool_call_id=f"call_{i}",
            token_count=tokens_per_event,
            timestamp=ts + 5.0,
        )
        events.append(res_event)

        # Assistant response
        a_event = ledger.append_event(
            event_type="assistant",
            content=f"[{topic_name}] 分析结论 {i}：验签失败系公钥证书序列号不匹配导致。",
            token_count=tokens_per_event,
            timestamp=ts + 10.0,
        )
        events.append(a_event)

    return events


def test_topic_switch_archives_old_epoch_and_increments_epoch(tmp_path: Path):
    """验证话题切换时：旧 Epoch 现场成功封存落盘，且账本 current_epoch_id 自增。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger, config=WindowConfig(epochs_dir=epochs_dir))
    handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)

    # 灌入旧主题“微信支付排错”并设置旧任务摘要
    window.rolling_task_summary = "前置任务：持续排查微信支付回调验签失败的问题。"
    _seed_topic_events(ledger=ledger, topic_name="微信支付排错", num_turns=3)

    # 执行 180 度转弯话题切换
    result = handler.archive_current_topic_and_switch(
        old_topic_summary="微信支付验签排错基本定位，需等待运营更新证书序列号。",
        new_topic_intent="规划东京 5 天 4 晚旅游行程与美食清单",
    )

    assert isinstance(result, TopicSwitchResult)
    assert result.success is True
    assert result.archived_epoch_id == 1
    assert "epoch_1_summary.md" in result.archived_file_path
    assert Path(result.archived_file_path).exists()

    # 验证磁盘上的归档内容包含旧任务摘要与细节
    archive_text = Path(result.archived_file_path).read_text(encoding="utf-8")
    assert "微信支付验签排错基本定位" in archive_text
    assert "证书序列号" in archive_text
    assert "Epoch 1" in archive_text

    # 验证账本 Epoch 自增
    assert ledger.current_epoch_id == 2


def test_topic_switch_watermark_quantum_leap_clears_old_context(tmp_path: Path):
    """验证水印秒级瞬移：切换后活跃窗口内的旧事件万级 Token 彻底人间蒸发，仅保留新起点。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger, config=WindowConfig(epochs_dir=epochs_dir))
    handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)

    # 灌入旧任务多轮对话（共 12 个事件，累积 18,000 Token）
    _seed_topic_events(ledger=ledger, topic_name="支付网关高并发调优", num_turns=3, tokens_per_event=1500)
    snap_before = window.get_active_window()
    assert len(snap_before.events) == 12
    assert snap_before.total_tokens >= 18000

    # 模拟用户突然发出 180 度大转弯新话题（seq_id = 13）
    new_user_event = ledger.append_event(
        event_type="user",
        content="帮我看看日本东京秋叶原附近有什么推荐的高分拉面馆？",
        token_count=30,
        timestamp=1_700_010_000.0,
    )
    assert new_user_event.seq_id == 13

    # 执行话题切换：指定新话题起始 seq_id（或由 handler 自适应探测最新 user 事件）
    result = handler.archive_current_topic_and_switch(
        old_topic_summary="支付网关线程池压测完成。",
        new_topic_intent="东京秋叶原拉面馆推荐",
        switch_user_seq_id=new_user_event.seq_id,
    )
    assert result.success is True

    # 检查瞬移后的活跃窗口快照
    snap_after = window.get_active_window()
    # 验证水位线跳跃到新指令之前（watermark == 12）
    assert window.window_watermark == 12
    # 验证活跃窗口中旧话题万级 Token 彻底蒸发，仅剩新话题的 user 事件
    assert len(snap_after.events) == 1
    assert snap_after.events[0].seq_id == 13
    assert "拉面馆" in snap_after.events[0].content
    assert snap_after.total_tokens == 30

    # 验证任务滚动摘要已重置为新任务意图
    assert "东京秋叶原拉面馆推荐" in window.rolling_task_summary
    assert "支付网关" not in window.rolling_task_summary


def test_topic_switch_auto_detect_latest_user_turn_when_unspecified(tmp_path: Path):
    """验证未显式传 switch_user_seq_id 时，handler 能自动逆向对齐最新 user 事件。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger, config=WindowConfig(epochs_dir=epochs_dir))
    handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)

    _seed_topic_events(ledger=ledger, topic_name="MySQL死锁排查", num_turns=2)
    # 追加新话题提问
    latest_user = ledger.append_event(
        event_type="user",
        content="我想了解量子力学的双缝干涉实验",
        token_count=25,
    )

    # 不传 switch_user_seq_id，自适应对齐
    handler.archive_current_topic_and_switch(
        old_topic_summary="MySQL 间隙锁冲突已确认",
        new_topic_intent="学习量子物理双缝干涉",
    )

    assert window.window_watermark == latest_user.seq_id - 1
    active_events = window.get_active_window().events
    assert len(active_events) == 1
    assert active_events[0].seq_id == latest_user.seq_id


def test_three_tier_retriever_tier1_system_index(tmp_path: Path):
    """验证第 1 层：常驻轻量级 INDEX.md 索引读取与容错。"""
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    retriever = ThreeTierRetriever(memory_dir=memory_dir)

    # 1. 初始不存在 INDEX.md 时的安全兜底
    empty_index = retriever.get_system_index()
    assert isinstance(empty_index, str)
    assert empty_index == "" or "INDEX" in empty_index

    # 2. 写入轻量规范 INDEX.md
    index_file = memory_dir / "INDEX.md"
    index_content = (
        "# 长期记忆索引库\n"
        "- [user_profile.md]: 个人画像与技术栈偏好（全栈开发、偏好 TS/Python）\n"
        "- [japan_travel.md]: 日本出行攻略与饮食忌口（不吃芥末、喜好抹茶）\n"
    )
    index_file.write_text(index_content, encoding="utf-8")

    # 验证读取命中
    loaded_index = retriever.get_system_index()
    assert "长期记忆索引库" in loaded_index
    assert "japan_travel.md" in loaded_index
    assert "偏好 TS/Python" in loaded_index


def test_three_tier_retriever_tier2_read_memory_topic(tmp_path: Path):
    """验证第 2 层：通过 read_memory_topic 定向精准载入特定 Markdown 主题文件。"""
    memory_dir = tmp_path / "memory"
    topics_dir = memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)
    retriever = ThreeTierRetriever(memory_dir=memory_dir)

    # 准备主题文件
    topic_file = topics_dir / "japan_travel.md"
    topic_file.write_text(
        "# 日本出行偏好\n- 住宿：喜欢靠近山手线的大塚或日暮里站\n- 饮食：重度抹茶爱好者，对生冷海鲜过敏\n",
        encoding="utf-8",
    )

    # 1. 带 .md 后缀读取
    content1 = retriever.read_memory_topic("japan_travel.md")
    assert "重度抹茶爱好者" in content1
    assert "山手线" in content1

    # 2. 不带 .md 后缀自动补全
    content2 = retriever.read_memory_topic("japan_travel")
    assert content2 == content1

    # 3. 读取不存在的主题文件抛出 FileNotFoundError，并提示可用主题
    with pytest.raises(FileNotFoundError) as exc_info:
        retriever.read_memory_topic("non_existent_topic")
    assert "japan_travel.md" in str(exc_info.value)


def test_three_tier_retriever_tier3_search_raw_events(tmp_path: Path):
    """验证第 3 层：委托 MainEventLedger 按关键字/正则倒序翻阅陈年日志。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    retriever = ThreeTierRetriever(memory_dir=tmp_path / "memory", ledger=ledger)

    ledger.append_event(event_type="user", content="配置 AWS S3 Bucket 名称为 my-backup-vault-2026")
    ledger.append_event(event_type="assistant", content="已验证 S3 存储桶策略生效")
    ledger.append_event(event_type="user", content="今天天气真好，去公园散步")

    matches = retriever.search_raw_events(query="S3 Bucket", limit=2)
    assert len(matches) == 1
    assert "my-backup-vault-2026" in matches[0].content
    assert matches[0].event_type == "user"


def test_parallel_recall_coordinator_prioritizes_topic_switch_over_retrieval(tmp_path: Path):
    """验证并联调用调度核心：同轮并发 Tool Calls 中，话题切换必须先于记忆读取生效。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    memory_dir = tmp_path / "memory"
    topics_dir = memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)

    # 准备主题文件
    (topics_dir / "travel_diet.md").write_text("主人饮食偏好：偏好低糖、无乳糖奶制品。", encoding="utf-8")

    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger, config=WindowConfig(epochs_dir=epochs_dir))
    handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)
    retriever = ThreeTierRetriever(memory_dir=memory_dir, ledger=ledger)
    coordinator = ParallelRecallCoordinator(topic_handler=handler, retriever=retriever)

    # 灌入旧主题“Kubernetes 集群升级”对话
    _seed_topic_events(ledger=ledger, topic_name="Kubernetes 集群升级", num_turns=3)
    assert len(window.get_active_window().events) == 12

    # 用户发出转折意图
    new_user = ledger.append_event(
        event_type="user",
        content="帮我挑选明天去京都的下午茶点心店",
        token_count=20,
    )

    # 模拟主模型同轮同时发出的 2 个并行 Tool Calls（顺序故意打乱：读取记忆在前，切换话题在后）
    calls = [
        ParallelToolCall(
            call_id="call_read_memory",
            function_name="read_memory_topic",
            arguments={"topic_name": "travel_diet.md"},
        ),
        ParallelToolCall(
            call_id="call_topic_switch",
            function_name="archive_current_topic_and_switch",
            arguments={
                "old_topic_summary": "K8s 集群升级至 1.30 方案评审完毕。",
                "new_topic_intent": "京都下午茶点心店推荐",
                "switch_user_seq_id": new_user.seq_id,
            },
        ),
    ]

    results = coordinator.execute_parallel_calls(calls)

    # 验证两个调用的执行结果均已返回
    assert "call_read_memory" in results
    assert "call_topic_switch" in results

    # 验证记忆读取结果成功拿到
    assert "低糖、无乳糖" in results["call_read_memory"]

    # 验证话题切换结果成功返回
    switch_res = results["call_topic_switch"]
    assert switch_res["success"] is True

    # 核心因果断言：活跃窗口必须已经被瞬移清理！旧 K8s 上下文完全消失，仅剩新 user 事件
    active_events = window.get_active_window().events
    assert len(active_events) == 1
    assert active_events[0].seq_id == new_user.seq_id
    assert "京都下午茶" in active_events[0].content
    assert "京都下午茶点心店推荐" in window.rolling_task_summary


def test_parallel_recall_coordinator_handles_tier3_raw_log_search(tmp_path: Path):
    """验证并联调用调度器对 Tier 3 search_raw_events 的无缝支撑。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    ledger.append_event(event_type="assistant", content="旧项目凭证 API_KEY=sk-old-project-9988")

    window = SlidingWindowLedger(ledger=ledger)
    handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")
    retriever = ThreeTierRetriever(memory_dir=tmp_path / "memory", ledger=ledger)
    coordinator = ParallelRecallCoordinator(topic_handler=handler, retriever=retriever)

    calls = [
        ParallelToolCall(
            call_id="call_search_1",
            function_name="search_raw_events",
            arguments={"query": "API_KEY", "limit": 1},
        )
    ]

    results = coordinator.execute_parallel_calls(calls)
    assert "call_search_1" in results
    matched = results["call_search_1"]
    assert isinstance(matched, list)
    assert len(matched) == 1
    assert "sk-old-project-9988" in matched[0]["content"]


def test_topic_switch_empty_active_window_safe(tmp_path: Path):
    """验证边界：当没有任何旧事件（冷启动或已处于空窗口）时，话题切换应幂等且不崩溃。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger)
    handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")

    result = handler.archive_current_topic_and_switch(
        old_topic_summary="冷启动无任务",
        new_topic_intent="直接开启新任务",
    )
    assert result.success is True
    assert ledger.current_epoch_id == 2
    assert window.window_watermark == 0
    assert "直接开启新任务" in window.rolling_task_summary


def test_pydantic_schema_validation():
    """验证 Pydantic 模型的数据校验与 extra 允许。"""
    req = TopicSwitchRequest(
        old_topic_summary="旧总结",
        new_topic_intent="新意图",
        extra_info="允许额外元数据",
    )
    assert req.old_topic_summary == "旧总结"
    assert req.model_dump().get("extra_info") == "允许额外元数据"

    res = TopicSwitchResult(
        success=True,
        archived_epoch_id=1,
        archived_file_path="/tmp/epoch_1_summary.md",
        new_topic_intent="新意图",
        message="切换成功",
    )
    dumped = res.model_dump()
    assert dumped["success"] is True
    assert dumped["archived_epoch_id"] == 1
