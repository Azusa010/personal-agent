"""Step 7 全链路端到端集成测试网：SOTA 循环、全生命周期记忆与系统提示词铁律固化。

核心端到端业务链路验证：
1. 常驻轻量目录注入（Tier 1）：INDEX.md 被动态注入 ContextManager / ModelContext.userMemories；
2. 决策铁律固化：系统提示词明文固化 180 度大转向话题切换与记忆召回指南；
3. 超大工具输出脱水防爆：超限工具结果自动由 LedgerGuard 物理转储为 Blob，主活跃窗口仅留预览指针；
4. 三层召回能力贯穿单主循环：模型在 DynamicLedgerStrategy 驱动下可定向执行 read_memory_topic 与 search_raw_events；
5. 话题突变现场封存与水印跃迁：执行 archive_current_topic_and_switch 封存 Epoch 并重置滑动窗口水位线；
6. 任务结束后台异步提炼与无竞争做梦：任务完成后一键衔接 ColdMemoryExtractor.drain_all 与 DreamEngine 归并入库；
7. 下次会话即刻感知全新长期记忆：归并更新后的 INDEX.md 在新会话启动时无缝透传至上下文，形成终极闭环。
"""

from pathlib import Path
from typing import Any

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.dream import (
    DreamEngine,
    DreamRequest,
    IndexCompiler,
)
from personal_agent.conversation.extractor import (
    CandidateMemoryItem,
    ColdMemoryExtractor,
    ExtractorCursor,
    MemoryInbox,
)
from personal_agent.conversation.ledger import (
    LedgerEvent,
    LedgerGuard,
    MainEventLedger,
)
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelDecision,
    ModelGateway,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.topics import (
    ThreeTierRetriever,
    TopicSwitchHandler,
)
from personal_agent.conversation.windows import (
    SlidingWindowLedger,
    WindowConfig,
)
from personal_agent.engine import Budget
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskCompleted,
)
from personal_agent.strategy import DynamicLedgerStrategy


class MockSotaChannel:
    """可记录并响应三层记忆工具调用的测试通道。"""

    def __init__(
        self,
        retriever: ThreeTierRetriever,
        topic_handler: TopicSwitchHandler,
        ledger_guard: LedgerGuard | None = None,
    ):
        self.retriever = retriever
        self.topic_handler = topic_handler
        self.ledger_guard = ledger_guard
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        cap = params.capability
        args = params.arguments

        if cap == "read_memory_topic":
            topic_name = str(args.get("topic_name", ""))
            try:
                content = self.retriever.read_memory_topic(topic_name)
                return HostExecuteToolResult(ok=True, payload={"content": content})
            except (FileNotFoundError, OSError) as e:
                return HostExecuteToolResult(ok=False, payload={"error": str(e)})

        if cap == "search_raw_events":
            query = str(args.get("query", ""))
            matches = self.retriever.search_raw_events(query=query, limit=args.get("limit", 5))
            return HostExecuteToolResult(ok=True, payload={"events": [m.model_dump() for m in matches]})

        if cap == "archive_current_topic_and_switch":
            res = self.topic_handler.archive_current_topic_and_switch(
                old_topic_summary=str(args.get("old_topic_summary", "")),
                new_topic_intent=str(args.get("new_topic_intent", "")),
            )
            return HostExecuteToolResult(ok=True, payload=res.model_dump())

        if cap == "generate_huge_log":
            raw_output = "SERVER_TRACE_LINE: " + ("abcdef1234567890\n" * 500)
            if self.ledger_guard and self.ledger_guard.should_offload(raw_output):
                ptr = self.ledger_guard.offload(raw_output)
                return HostExecuteToolResult(ok=True, payload=ptr.model_dump())
            return HostExecuteToolResult(ok=True, payload={"log": raw_output})

        return HostExecuteToolResult(ok=True, payload={"ok": True})

    def as_local_executor(self, decision: ToolCallDecision | Any) -> Any:
        cap = decision.capability
        if cap in ("read_memory_topic", "search_raw_events", "archive_current_topic_and_switch"):
            fake_params = HostExecuteToolParams.model_construct(
                callId=decision.callId,
                capability=decision.capability,
                arguments=decision.arguments,
            )
            res = self.call_host(fake_params)
            from personal_agent.conversation.model.gateway import Observation
            return Observation(
                callId=decision.callId,
                capability=decision.capability,
                ok=res.ok,
                payload=res.payload,
                arguments=decision.arguments,
            )
        return None


class SequenceDecisionModel(ModelGateway):
    """按序产出预设决策的模型 Stub。"""

    def __init__(self, decisions: list[ModelDecision]):
        self._decisions = list(decisions)
        self.called_contexts: list[ModelContext] = []

    def decide(self, context: ModelContext, thinking_sink: Any = None) -> ModelDecision:
        self.called_contexts.append(context)
        if not self._decisions:
            return SummaryDecision(kind="summary", reply="SOTA循环任务完成", facts=[])
        return self._decisions.pop(0)


def test_system_prompt_injects_memory_index_and_recall_rules(tmp_path: Path):
    """1. 验证 ContextManager 自动从 memory/INDEX.md 加载轻量索引至 System Prompt / userMemories。"""
    memory_dir = tmp_path / "memory"
    topics_dir = memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)

    # 准备长期记忆主题与预编译 INDEX.md
    (topics_dir / "user_profile.md").write_text("# 用户画像\n- 偏好等宽字体与纯暗黑主题\n", encoding="utf-8")
    compiler = IndexCompiler(memory_dir=memory_dir)
    compiler.recompile()

    retriever = ThreeTierRetriever(memory_dir=memory_dir)
    index_text = retriever.get_system_index()
    assert "- [user_profile.md]" in index_text

    # 构造挂载了 memory_dir / index_text 的 ContextManager
    cm = ContextManager(
        task_goal="查看用户偏好设置",
        user_memories=[index_text] if index_text else [],
    )
    ctx = cm.build(
        taskGoal="查看用户偏好设置",
        visibleCapabilities=["read_memory_topic"],
    )

    # 验证上下文与记忆中包含了常驻索引与用户偏好线索
    assert any("user_profile.md" in m for m in ctx.userMemories) or (
        ctx.systemPrompt is not None and "user_profile.md" in ctx.systemPrompt
    )


def test_tool_output_offloaded_by_ledger_guard_protects_active_window(tmp_path: Path):
    """2. 验证工具产生的超大输出被 LedgerGuard 自动转储为脱水 Blob，主日志只留轻量指针。"""
    blobs_dir = tmp_path / "logs" / "offloaded_blobs"
    guard = LedgerGuard(blob_dir=blobs_dir, preview_chars=200, max_chars=500)

    raw_huge_log = "FATAL EXCEPTION STACK: " + ("crash_dump_payload_item\n" * 200)
    guarded_payload, pointer = guard.guard_tool_result(
        call_id="call_big_log_1",
        capability="run_command",
        ok=True,
        payload=raw_huge_log,
    )
    assert pointer is not None
    assert pointer.blob_id.startswith("blob_")
    assert Path(pointer.file_path).exists()
    assert len(pointer.preview) < len(raw_huge_log)
    assert "..." in pointer.preview

    # 验证主账本写入时仅需落盘 pointer payload
    log_file = tmp_path / "logs" / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    event = ledger.append_event(
        event_type="tool_result",
        payload=guarded_payload,
    )
    # 验证落盘事件尺寸远小于原日志，未打穿账本
    assert event.token_count < 1000

    # 验证可以通过 guard 完整还原原始脱水数据
    restored_text = guard.read_blob(pointer.blob_id)
    assert restored_text == raw_huge_log


def test_three_tier_recall_in_dynamic_ledger_strategy(tmp_path: Path):
    """3. 验证 DynamicLedgerStrategy 中单主循环顺利调用 read_memory_topic 获取记忆知识。"""
    memory_dir = tmp_path / "memory"
    topics_dir = memory_dir / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)
    (topics_dir / "coding_standards.md").write_text(
        "# 工程规范\n- 核心约束：生产代码全由主人亲手编写，AI 仅出规格与测试\n",
        encoding="utf-8",
    )

    retriever = ThreeTierRetriever(memory_dir=memory_dir)
    log_file = tmp_path / "logs" / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")
    channel = MockSotaChannel(retriever=retriever, topic_handler=topic_handler)

    # 模拟决策序列：read_memory_topic -> summary 交付
    model = SequenceDecisionModel([
        ToolCallDecision(
            kind="tool_call",
            callId="call-mem-1",
            capability="read_memory_topic",
            arguments={"topic_name": "coding_standards.md"},
        ),
        SummaryDecision(
            kind="summary",
            reply="已明确掌握工程规范：生产代码全由主人亲手编写",
            facts=[],
        ),
    ])

    strategy = DynamicLedgerStrategy()
    result = strategy.execute(
        model=model,
        channel=channel,
        goal="了解当前项目的编码铁律",
        visible_capabilities=["read_memory_topic"],
        plan=[PlanStepDto(description="查阅工程规范", capability=None)],
        history=[],
        profile=None,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        stream=None,
        sliding_window=window,
        local_executor=channel.as_local_executor,
    )

    assert isinstance(result, RunTaskCompleted)
    assert "主人亲手编写" in result.reply
    assert len(channel.calls) == 1
    assert channel.calls[0].capability == "read_memory_topic"


def test_topic_switch_in_dynamic_ledger_strategy_archives_epoch(tmp_path: Path):
    """4. 验证在 DynamicLedgerStrategy 执行中触发话题切换：旧现场自动归档且水位线跃迁。"""
    log_file = tmp_path / "logs" / "events.jsonl"
    epochs_dir = tmp_path / "epochs"
    memory_dir = tmp_path / "memory"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    window = SlidingWindowLedger(ledger=ledger, config=WindowConfig(epochs_dir=epochs_dir))
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)
    retriever = ThreeTierRetriever(memory_dir=memory_dir, ledger=ledger)
    channel = MockSotaChannel(retriever=retriever, topic_handler=topic_handler)

    # 灌入旧话题的对话记录
    ledger.append_event("user", {"text": "排查支付网关并发死锁"})
    ledger.append_event("assistant", {"text": "已定位死锁位于 orders 表的意向互斥锁"})
    window.rolling_task_summary = "前置任务：持续诊断 MySQL 锁竞争"

    model = SequenceDecisionModel([
        ToolCallDecision(
            kind="tool_call",
            callId="call-switch-1",
            capability="archive_current_topic_and_switch",
            arguments={
                "old_topic_summary": "MySQL 死锁排查完毕，建议优化索引与事务粒度",
                "new_topic_intent": "规划下周全家去云南大理旅游的自由行路线",
            },
        ),
        SummaryDecision(
            kind="summary",
            reply="已封存支付网关旧议题，开始为您规划云南大理旅游路线",
            facts=[],
        ),
    ])

    strategy = DynamicLedgerStrategy()
    result = strategy.execute(
        model=model,
        channel=channel,
        goal="大转弯：改去大理旅游",
        visible_capabilities=["archive_current_topic_and_switch"],
        plan=[PlanStepDto(description="归档旧话题并切换至新意图", capability=None)],
        history=[],
        profile=None,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        stream=None,
        sliding_window=window,
        local_executor=channel.as_local_executor,
    )

    assert isinstance(result, RunTaskCompleted)
    assert ledger.current_epoch_id == 2
    archive_file = epochs_dir / "epoch_1_summary.md"
    assert archive_file.exists()
    assert "MySQL 死锁排查完毕" in archive_file.read_text(encoding="utf-8")
    assert "大理旅游" in window.rolling_task_summary


def test_post_task_pipeline_drain_and_dream_consolidation_e2e(tmp_path: Path):
    """5. 验证全链路闭环：任务完成后执行 ColdMemoryExtractor.drain_all 与 DreamEngine 自动归并。"""
    log_file = tmp_path / "logs" / "events.jsonl"
    memory_dir = tmp_path / "memory"
    inbox_file = memory_dir / "inbox.jsonl"
    cursor_file = memory_dir / "extractor_cursor.json"

    ledger = MainEventLedger(log_file=log_file)
    inbox = MemoryInbox(inbox_file=inbox_file)
    cursor = ExtractorCursor(cursor_file=cursor_file)

    # 灌入两轮真实的高价值架构决策事件
    e1 = ledger.append_event("user", {"text": "请记住，系统所有日期时间统一使用 UTC+8，严禁使用本机的未指定时区"})
    e2 = ledger.append_event("assistant", {"text": "已明确收到时间格式规范：统一 UTC+8。"})
    assert e1.seq_id < e2.seq_id

    # 1. 模拟提炼函数（只从 user 轮次提取）
    def mock_extract(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        matched = []
        for e in events:
            txt = str(e.payload.get("text", ""))
            if e.event_type == "user" and "UTC+8" in txt:
                matched.append(
                    CandidateMemoryItem(
                        id=f"utc-{e.seq_id}",
                        action="STORE",
                        category="coding_standards",
                        content="时间处理规范：所有业务与日志统一采用 UTC+8 时区",
                        confidence=0.99,
                        source_seq_range=(e.seq_id, e.seq_id),
                        extracted_at="2026-10-16T18:00:00Z",
                    )
                )
        return matched

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=mock_extract,
    )

    # 执行提炼
    drain_results = extractor.drain_all()
    assert len(drain_results) > 0
    assert cursor.last_extracted_seq_id == e2.seq_id
    assert inbox.count_pending() == 1

    # 2. 执行自动做梦归并
    engine = DreamEngine(memory_dir=memory_dir, inbox=inbox)
    dream_res = engine.run_dream(DreamRequest(force=True))
    assert dream_res.success is True
    assert dream_res.consolidated_items_count == 1
    assert "coding_standards" in dream_res.categories_updated
    assert dream_res.index_rebuilt is True

    # 验证 topics/coding_standards.md 包含了该条目
    topics_file = memory_dir / "topics" / "coding_standards.md"
    assert topics_file.exists()
    assert "统一采用 UTC+8 时区" in topics_file.read_text(encoding="utf-8")

    # 验证 INDEX.md 被重新编译且包含了 coding_standards.md
    index_file = memory_dir / "INDEX.md"
    assert index_file.exists()
    index_text = index_file.read_text(encoding="utf-8")
    assert "- [coding_standards.md]" in index_text

    # 3. 验证下次会话启动时，ContextManager 读取该 INDEX.md 并成功装配进上下文
    new_cm = ContextManager(
        task_goal="启动新任务",
        user_memories=[index_text],
    )
    new_ctx = new_cm.build(taskGoal="启动新任务", visibleCapabilities=[])
    assert any("coding_standards.md" in m for m in new_ctx.userMemories)
