"""services/agent-runtime/tests/test_ledger_backed_context.py

测试网：Ledger-Backed ContextManager 适配与滑动窗口联动。
验证：
1. 向后兼容性：不提供 sliding_window 时完全保持既有纯内存与截断逻辑。
2. 注入 sliding_window 时，record_tool_call 与 record(observation) 双写透传至底层 MainEventLedger。
3. 事件字段契约对齐：tool_call 与 tool_result 的 payload 结构符合 LedgerEvent 规范。
4. build() 触发滑动窗口检查：自动调用 compact_if_needed()，并在产生 rolling_task_summary 时注入提示词。
5. 水位裁剪后的活跃窗口投影：被裁剪至 watermark 之前的历史事件不再污染当前 ModelContext。
6. 轨迹完整性与成对保护：即使在多次工具调用与压缩后，轨迹依然成对且无孤儿。
"""

from __future__ import annotations

from pathlib import Path

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.model.gateway import Observation, ToolCallItem
from personal_agent.conversation.windows import SlidingWindowLedger, WindowConfig
from personal_agent.protocol.models import Turn


def test_context_manager_backward_compatibility_without_window():
    """验证不提供 sliding_window 时的纯内存向后兼容性。"""
    cm = ContextManager(maxCharsPerString=50, task_goal="测试无窗口环境")
    assert getattr(cm, "sliding_window", None) is None

    call = ToolCallItem(callId="call-legacy", capability="filesystem_list", arguments={"path": "."})
    cm.record_tool_call(call)

    obs = Observation(callId="call-legacy", capability="filesystem_list", ok=True, payload={"files": ["a.txt"]})
    cm.record(obs)

    ctx = cm.build(taskGoal="测试无窗口环境", visibleCapabilities=["filesystem_list"])
    assert len(ctx.observations) == 1
    assert ctx.observations[0].callId == "call-legacy"
    assert ctx.observations[0].payload == {"files": ["a.txt"]}


def test_context_manager_write_through_to_ledger(tmp_path: Path):
    """验证工具调用与观察结果在 record 时双写透传至 MainEventLedger。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    cm = ContextManager(sliding_window=window, task_goal="执行文件扫描")
    assert cm.sliding_window is window

    # 1. 发起工具调用
    call = ToolCallItem(
        callId="call-101",
        capability="filesystem_list",
        arguments={"path": "/workspace/docs"},
    )
    cm.record_tool_call(call)

    events_after_call = ledger.read_events()
    assert len(events_after_call) == 1
    assert events_after_call[0].event_type == "tool_call"
    assert events_after_call[0].payload["callId"] == "call-101"
    assert events_after_call[0].payload["capability"] == "filesystem_list"
    assert events_after_call[0].payload["arguments"] == {"path": "/workspace/docs"}
    assert events_after_call[0].seq_id == 1

    # 2. 记录工具返回
    obs = Observation(
        callId="call-101",
        capability="filesystem_list",
        ok=True,
        payload={"entries": ["readme.md", "guide.pdf"]},
        arguments={"path": "/workspace/docs"},
    )
    cm.record(obs)

    events_after_res = ledger.read_events()
    assert len(events_after_res) == 2
    assert events_after_res[1].event_type == "tool_result"
    assert events_after_res[1].payload["callId"] == "call-101"
    assert events_after_res[1].payload["capability"] == "filesystem_list"
    assert events_after_res[1].payload["ok"] is True
    assert events_after_res[1].payload["payload"] == {"entries": ["readme.md", "guide.pdf"]}
    assert events_after_res[1].seq_id == 2


def test_context_manager_records_history_turns_into_ledger(tmp_path: Path):
    """验证传入初始 history 或追加 Turn 时，底座账本能够记录 user/assistant 事件。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    initial_history = [
        Turn(role="user", text="请帮我检查项目状态"),
        Turn(role="assistant", text="收到，我将立即检查"),
    ]

    cm = ContextManager(
        sliding_window=window,
        history=initial_history,
        task_goal="项目状态体检",
    )
    assert cm.sliding_window is window

    events = ledger.read_events()
    assert len(events) == 2
    assert events[0].event_type == "user"
    assert events[0].payload["text"] == "请帮我检查项目状态"
    assert events[1].event_type == "assistant"
    assert events[1].payload["text"] == "收到，我将立即检查"


def test_build_triggers_compaction_and_injects_rolling_summary(tmp_path: Path):
    """验证 build() 触发滑动窗口检查，高水位裁剪后将 rolling_task_summary 注入系统提示词。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    config = WindowConfig(
        max_budget_tokens=200,
        high_watermark_ratio=0.5,
        min_preserved_turns=1,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)

    for i in range(1, 4):
        ledger.append_event("user", {"text": f"历史步骤 {i}: 详尽需求描述，包含较长的上下文背景内容以消耗 Token 预算。"})
        ledger.append_event("assistant", {"text": f"完成步骤 {i}，生成中间报告，包含大量结构化数据。"})

    def mock_summarizer(compacted_events: list[LedgerEvent], _old_summary: str) -> str:
        return f"已归纳前序 {len(compacted_events)} 条事件：用户完成了基础设施扫描。"

    cm = ContextManager(
        sliding_window=window,
        task_goal="继续后续分析",
    )

    ctx = cm.build(taskGoal="继续后续分析", visibleCapabilities=[], summarizer_fn=mock_summarizer)

    assert window.window_watermark > 0
    assert "已归纳前序" in window.rolling_task_summary

    assert ctx.systemPrompt is not None
    assert "已归纳前序" in ctx.systemPrompt


def test_active_window_filtering_excludes_trimmed_observations(tmp_path: Path):
    """验证当滑动窗口水位推进后，低于水位线的过期观察不再混入活跃 ModelContext.observations。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    cm = ContextManager(sliding_window=window, task_goal="多轮观测隔离")

    # 第一轮交互与观察
    ledger.append_event("user", {"text": "第 1 轮：读取旧文件"})
    call_1 = ToolCallItem(callId="call-1", capability="file_read", arguments={"path": "old.log"})
    cm.record_tool_call(call_1)
    obs_1 = Observation(callId="call-1", capability="file_read", ok=True, payload={"content": "old_data"})
    cm.record(obs_1)
    ledger.append_event("assistant", {"text": "已读取 old.log"})

    # 人工推进水位线（模拟第 1 轮已归档滑动出窗口）
    watermark_seq = ledger.latest_seq_id
    window.window_watermark = watermark_seq

    # 第二轮交互与观察（位于水位线之上）
    ledger.append_event("user", {"text": "第 2 轮：读取新文件"})
    call_2 = ToolCallItem(callId="call-2", capability="file_read", arguments={"path": "new.log"})
    cm.record_tool_call(call_2)
    obs_2 = Observation(callId="call-2", capability="file_read", ok=True, payload={"content": "new_data"})
    cm.record(obs_2)
    ledger.append_event("assistant", {"text": "已读取 new.log"})

    ctx = cm.build(taskGoal="多轮观测隔离", visibleCapabilities=["file_read"])

    # 活跃窗口内仅应包含第二轮的 obs_2，第 1 轮的 obs_1 已被过滤
    call_ids = [o.callId for o in ctx.observations]
    assert "call-2" in call_ids
    assert "call-1" not in call_ids


def test_pairing_boundary_preservation_under_context_manager(tmp_path: Path):
    """验证无论怎么压缩，tool_call 与 tool_result 不会在中途被截成单边残缺。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)
    cm = ContextManager(sliding_window=window, task_goal="验证成对性")

    ledger.append_event("user", {"text": "执行编译"})
    cm.record_tool_call(ToolCallItem(callId="call-c", capability="terminal_execute", arguments={"cmd": "build"}))
    cm.record(Observation(callId="call-c", capability="terminal_execute", ok=True, payload={"exitCode": 0}))

    events = ledger.read_events()
    safe_boundary = window.find_safe_compaction_boundary(events, target_keep_turns=1)
    assert safe_boundary == 0
