"""agent.stream 通知的发出端（TASK-033 R1）。

三处同步里「Python 发出端」这一侧的检查点：通知形状、发射器的边界、
engine 与剧本模型的接线。TS 侧的对称用例在
packages/protocol/tests/agent-stream.test.ts，共享样本在
packages/protocol/fixtures/agent-stream.*.notification.json。

一条不变量贯穿本文件：通知是尽力而为的实时预览，agent.run_task 的回包
仍是唯一事实来源——所以「写不出去」不该让任务失败，「不传 sink」也不该
改变任何行为。
"""

import pytest

from personal_agent.context import ContextManager
from personal_agent.engine import EVENT_MODEL_USAGE, AgentEngine
from personal_agent.model_gateway import (
    ModelContext,
    ModelUsage,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import (
    AGENT_STREAM,
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskEvent,
)
from personal_agent.scripted_model import ScriptedModel
from personal_agent.stream import (
    THINKING_CHUNK_CHARS,
    StreamEmitter,
    chunk_text,
    event_notice,
    thinking_notice,
)

TASK_ID = "t-1"
OCCURRED_AT = "2026-09-18T09:00:00.123Z"
VISIBLE = ["filesystem.list"]


def make_event(
    event_type: str = "task_started", payload: dict | None = None
) -> RunTaskEvent:
    return RunTaskEvent(
        type=event_type,
        payload={"goal": "把 PDF 整理一下"} if payload is None else payload,
        occurredAt=OCCURRED_AT,
    )


def a_plan() -> list[PlanStepDto]:
    return [PlanStepDto(description="列出 Downloads 下的 PDF", capability="filesystem.list")]


class RecordingChannel:
    """只实现 engine 用到的 call_host：固定回 ok，并记下每次调用的参数。"""

    def __init__(self) -> None:
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        return HostExecuteToolResult(ok=True, path="/tmp/three-page-text.pdf")


class AccountingScriptedModel:
    """剧本 + 记账：用来钉住「model_usage 进落库事件、不进实时流」。

    不继承任何东西——engine 用 isinstance 问的是有没有 usage_snapshot
    （UsageReporting 是 runtime_checkable 的结构化端口）。
    """

    def __init__(self, decisions: list) -> None:
        self._inner = ScriptedModel(decisions, thinking_pause_seconds=0.0)

    def decide(self, context: ModelContext, on_thinking=None):
        return self._inner.decide(context, on_thinking=on_thinking)

    def usage_snapshot(self) -> ModelUsage:
        return ModelUsage(model="fake-live", inputTokens=120, outputTokens=32, calls=2)


def make_engine(model, notices: list[dict]) -> AgentEngine:
    return AgentEngine(
        model=model,
        channel=RecordingChannel(),
        context=ContextManager(plan=a_plan()),
        stream=StreamEmitter(notices.append, TASK_ID),
    )


def labels(notices: list[dict]) -> list[str]:
    """把通知序列压成可读标签，专门用来钉顺序。"""
    out: list[str] = []
    for notice in notices:
        params = notice["params"]
        if params["kind"] == "thinking":
            out.append("thinking")
        else:
            out.append(f"event:{params['event']['type']}")
    return out


# ---- 通知形状 ----


def test_event_notice_shape() -> None:
    assert event_notice(TASK_ID, make_event()) == {
        "jsonrpc": "2.0",
        "method": AGENT_STREAM,
        "params": {
            "kind": "event",
            "taskId": TASK_ID,
            "event": {
                "type": "task_started",
                "payload": {"goal": "把 PDF 整理一下"},
                "occurredAt": OCCURRED_AT,
            },
        },
    }


def test_thinking_notice_shape() -> None:
    assert thinking_notice(TASK_ID, "先列目录") == {
        "jsonrpc": "2.0",
        "method": AGENT_STREAM,
        "params": {"kind": "thinking", "taskId": TASK_ID, "delta": "先列目录"},
    }


# ---- chunk_text ----


def test_chunk_text_splits_into_fixed_size_pieces() -> None:
    assert chunk_text("abcdefg", 3) == ["abc", "def", "g"]


def test_chunk_text_empty_input_has_no_chunks() -> None:
    assert chunk_text("", 3) == []


def test_chunk_text_rejects_non_positive_size() -> None:
    # size=0 在 range(0, n, 0) 上会直接 ValueError，但那是运行到一半才炸；
    # 显式挡在门口，错误现场离调用方更近。
    with pytest.raises(ValueError):
        chunk_text("abc", 0)


# ---- StreamEmitter ----


def test_emitter_writes_both_kinds() -> None:
    written: list[dict] = []
    emitter = StreamEmitter(written.append, TASK_ID)
    emitter.event(make_event())
    emitter.thinking("先列目录")
    assert [n["params"]["kind"] for n in written] == ["event", "thinking"]
    assert written[0]["params"]["taskId"] == TASK_ID


def test_emitter_skips_empty_delta() -> None:
    # 空增量上线只有一个效果：让 UI 收到一条没有内容的通知。
    # 契约层 delta 是 min_length=1，这里不能让它先上船。
    written: list[dict] = []
    StreamEmitter(written.append, TASK_ID).thinking("")
    assert written == []


def test_emitter_swallows_write_failure() -> None:
    """显示通道的故障不升级成任务失败：回包仍是唯一事实来源。"""

    def boom(_notice: dict) -> None:
        raise RuntimeError("stdout 断了")

    emitter = StreamEmitter(boom, TASK_ID)
    emitter.event(make_event())  # 不抛
    emitter.thinking("还在想")  # 不抛


# ---- ScriptedModel ----


def test_scripted_model_forwards_thinking_in_chunks() -> None:
    text = "先列目录，再看要提取哪一份文件，最后按页码写摘要。" * 2
    model = ScriptedModel(
        [
            ToolCallDecision(
                kind="tool_call",
                callId="c-1",
                capability="filesystem.list",
                arguments={"rootId": "downloads"},
                thinking=text,
            )
        ],
        thinking_pause_seconds=0.0,
    )
    chunks: list[str] = []
    decision = model.decide(
        ModelContext(taskGoal="整理 PDF", visibleCapabilities=VISIBLE),
        on_thinking=chunks.append,
    )

    assert decision.kind == "tool_call"
    assert len(chunks) > 1
    assert "".join(chunks) == text
    assert all(len(chunk) <= THINKING_CHUNK_CHARS for chunk in chunks)


def test_scripted_model_without_thinking_emits_nothing() -> None:
    model = ScriptedModel(
        [
            ToolCallDecision(
                kind="tool_call",
                callId="c-1",
                capability="filesystem.list",
                arguments={"rootId": "downloads"},
            )
        ],
        thinking_pause_seconds=0.0,
    )
    chunks: list[str] = []
    model.decide(
        ModelContext(taskGoal="整理 PDF", visibleCapabilities=VISIBLE),
        on_thinking=chunks.append,
    )
    assert chunks == []


def test_scripted_model_decide_without_sink_is_fine() -> None:
    """不传 sink = 今天的行为：一条通知都不发，决策照旧。"""
    model = ScriptedModel(
        [SummaryDecision(kind="summary", reply="整理完了。", facts=[], thinking="材料齐了。")],
        thinking_pause_seconds=0.0,
    )
    decision = model.decide(ModelContext(taskGoal="整理 PDF", visibleCapabilities=VISIBLE))
    assert decision.kind == "summary"


# ---- engine 接线 ----


def test_engine_forwards_every_event_except_model_usage() -> None:
    notices: list[dict] = []
    model = AccountingScriptedModel(
        [
            ToolCallDecision(
                kind="tool_call",
                callId="c-1",
                capability="filesystem.list",
                arguments={"rootId": "downloads"},
            ),
            SummaryDecision(kind="summary", reply="整理完了。", facts=[]),
        ]
    )
    outcome = make_engine(model, notices).run("把 PDF 整理一下", VISIBLE)

    assert outcome.status == "completed"
    streamed = [n["params"]["event"]["type"] for n in notices]
    assert streamed == [e.type for e in outcome.events if e.type != EVENT_MODEL_USAGE]
    # 反过来钉一次：model_usage 确实进了落库事件，只是不进实时流——
    # 它是结算，不是过程。
    assert any(e.type == EVENT_MODEL_USAGE for e in outcome.events)


def test_engine_interleaves_thinking_before_its_decision() -> None:
    notices: list[dict] = []
    model = ScriptedModel(
        [
            ToolCallDecision(
                kind="tool_call",
                callId="c-1",
                capability="filesystem.list",
                arguments={"rootId": "downloads"},
                thinking="先列目录",
            ),
            SummaryDecision(kind="summary", reply="整理完了。", facts=[], thinking="材料齐了。"),
        ],
        thinking_pause_seconds=0.0,
    )
    outcome = make_engine(model, notices).run("把 PDF 整理一下", VISIBLE)

    assert outcome.status == "completed"
    assert labels(notices) == [
        "event:task_started",
        "thinking",
        "event:tool_called",
        "event:tool_result",
        "thinking",
        "event:task_completed",
    ]
    thinking_text = "".join(
        n["params"]["delta"] for n in notices if n["params"]["kind"] == "thinking"
    )
    assert thinking_text == "先列目录材料齐了。"


def test_engine_without_stream_still_completes() -> None:
    """不传 stream = 今天的行为：一条通知都不发，任务照旧跑完。"""
    model = ScriptedModel(
        [SummaryDecision(kind="summary", reply="整理完了。", facts=[])],
        thinking_pause_seconds=0.0,
    )
    engine = AgentEngine(
        model=model,
        channel=RecordingChannel(),
        context=ContextManager(plan=a_plan()),
    )
    outcome = engine.run("把 PDF 整理一下", VISIBLE)
    assert outcome.status == "completed"
