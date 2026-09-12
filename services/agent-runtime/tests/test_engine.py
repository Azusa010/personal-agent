"""AgentEngine 的行为测试。

对应 3d 的决定：
决定 3 → 预算两维独立，默认 8 / 5
决定 5 → 六个 event type 字面值钉死
决定 6 → ok:false 喂回模型继续跑，系统级异常中断

摘要的判定规则本身在 test_summary.py 里逐条钉（TASK-014）。这里只钉
engine 把参照集合从 ContextManager 接到验证器上、拒绝时走 _fail 收场。
"""

import json
import re

import pytest
from pydantic import ValidationError

from personal_agent.context import ContextManager
from personal_agent.engine import (
    CAPABILITY_NOT_REGISTERED,
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TOOL_CALLS,
    EVENT_BUDGET_EXHAUSTED,
    EVENT_TASK_COMPLETED,
    EVENT_TASK_FAILED,
    EVENT_TASK_STARTED,
    EVENT_TOOL_CALLED,
    EVENT_TOOL_RESULT,
    AgentEngine,
    Budget,
    now_occurred_at,
)
from personal_agent.host_channel import HostChannelClosed, HostRequestFailed
from personal_agent.model_gateway import (
    Observation,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import (
    OCCURRED_AT_PATTERN,
    HostExecuteToolResult,
    RunTaskCompleted,
    RunTaskFailed,
)
from personal_agent.scripted_model import ScriptedModel

VISIBLE = ["filesystem.list", "document.extract_pdf"]


class FakeChannel:
    """只实现 engine 用到的 call_host。

    不复用真 HostChannel：那会把 JSON 序列化与 inbox 分派一起测进来，
    engine 的分派逻辑跟传输层无关，混在一起红了分不清是哪层的错。
    """

    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def call_host(self, params):
        self.calls.append(params)
        if not self._results:
            raise AssertionError("FakeChannel 的预设结果已用尽，engine 多调了一次")
        item = self._results.pop(0)
        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


def list_result():
    return {
        "ok": True,
        "entries": [
            {
                "name": "a.pdf",
                "absolutePath": "D:/downloads/a.pdf",
                "modifiedAt": "2026-09-01T00:00:00Z",
                "sizeBytes": 2048,
            }
        ],
    }


def pdf_result(text="第一页正文"):
    return {"ok": True, "pages": [{"pageNumber": 1, "text": text}]}


def golden_path():
    """TASK-013 Validation 要求的 list→extract→summary 三步。"""
    return [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="document.extract_pdf",
            arguments={"path": "D:/downloads/a.pdf"},
        ),
        SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
    ]


def make_engine(results, decisions, budget=None, maxCharsPerString=None):
    channel = FakeChannel(results)
    model = ScriptedModel(decisions)
    context = (
        ContextManager()
        if maxCharsPerString is None
        else ContextManager(maxCharsPerString=maxCharsPerString)
    )
    engine = AgentEngine(
        model=model, channel=channel, context=context, budget=budget
    )
    return engine, model, channel, context


def tool_call(call_id="c-1", capability="filesystem.list", **args):
    return ToolCallDecision(
        kind="tool_call",
        callId=call_id,
        capability=capability,
        arguments=dict(args),
    )


# ---- 常量与样板 ----


def test_event_type_literals_are_pinned():
    # execution_events.type 在 TS 侧是 TEXT 无 CHECK，投影原样存不判类型。
    # 字面值一旦漂移，UI 的渲染分支会静默走到 default，timeline 上看不出区别。
    assert EVENT_TASK_STARTED == "task_started"
    assert EVENT_TOOL_CALLED == "tool_called"
    assert EVENT_TOOL_RESULT == "tool_result"
    assert EVENT_BUDGET_EXHAUSTED == "budget_exhausted"
    assert EVENT_TASK_COMPLETED == "task_completed"
    assert EVENT_TASK_FAILED == "task_failed"


def test_not_registered_code_matches_ts_registry():
    # 单一事实来源是 packages/protocol/schemas/errors.ts 的 ERROR_CODE。
    assert CAPABILITY_NOT_REGISTERED == "CAPABILITY_NOT_REGISTERED"


def test_budget_defaults():
    budget = Budget()
    assert budget.maxSteps == DEFAULT_MAX_STEPS == 8
    assert budget.maxToolCalls == DEFAULT_MAX_TOOL_CALLS == 5


def test_budget_rejects_zero_and_negative():
    for bad in (0, -1):
        with pytest.raises(ValidationError):
            Budget(maxSteps=bad)
        with pytest.raises(ValidationError):
            Budget(maxToolCalls=bad)


def test_now_occurred_at_matches_contract_pattern():
    # datetime.now(timezone.utc).isoformat() 默认是 +00:00 结尾加六位微秒，
    # 契约要的是毫秒三位加 Z，这一条钉住转换没漏。
    assert re.match(OCCURRED_AT_PATTERN, now_occurred_at())


def test_budget_exceeded_is_or_not_and():
    engine, *_ = make_engine([], [])
    assert engine._budget_exceeded(8, 0) is True
    assert engine._budget_exceeded(0, 5) is True
    assert engine._budget_exceeded(7, 4) is False
    assert engine._budget_exceeded(0, 0) is False


# ---- _execute：四路分派 ----


def test_execute_ok_true_carries_extra_fields_into_payload():
    engine, _, _, _ = make_engine([list_result()], [])
    obs = engine._execute(tool_call())
    assert obs.ok is True
    # payload 里要是 entries，不是一个只有 ok 的 dict：
    # 模型要读绝对路径才能决定下一步 extract 哪个文件。
    assert obs.payload["entries"][0]["absolutePath"] == "D:/downloads/a.pdf"
    assert "ok" not in obs.payload


def test_execute_ok_false_keeps_code_and_reason():
    failure = {
        "ok": False,
        "code": "PATH_OUT_OF_ROOT",
        "reason": "路径不在授权根目录内",
    }
    engine, _, _, _ = make_engine([failure], [])
    obs = engine._execute(tool_call(capability="document.extract_pdf", path="../x"))
    assert obs.ok is False
    assert obs.payload["code"] == "PATH_OUT_OF_ROOT"
    assert obs.payload["reason"] == "路径不在授权根目录内"


def test_execute_unregistered_capability_never_reaches_host():
    engine, _, channel, _ = make_engine([list_result()], [])
    # filesystem.rename 不在 CapabilityId 那六个字面值里，
    # 双端 schema 都会拒，请求根本发不出去。
    obs = engine._execute(tool_call(capability="filesystem.rename"))
    assert channel.calls == []
    assert obs.ok is False
    assert obs.payload["code"] == CAPABILITY_NOT_REGISTERED


def test_execute_uses_decision_call_id():
    engine, _, channel, _ = make_engine([list_result()], [])
    obs = engine._execute(tool_call(call_id="c-42"))
    # callId 是业务标识（模型起的），channel 内部的 call-1 是传输标识。
    # tool_called / tool_result / Observation 三处靠业务标识对齐。
    assert obs.callId == "c-42"
    assert channel.calls[0].callId == "c-42"


def test_execute_preserves_capability_and_arguments():
    engine, _, channel, _ = make_engine([pdf_result()], [])
    engine._execute(tool_call(call_id="c-2", capability="document.extract_pdf", path="D:/a.pdf"))
    assert channel.calls[0].capability == "document.extract_pdf"
    assert channel.calls[0].arguments == {"path": "D:/a.pdf"}


def test_execute_returns_observation_type():
    engine, _, _, _ = make_engine([list_result()], [])
    assert isinstance(engine._execute(tool_call()), Observation)


def test_execute_lets_host_request_failed_propagate():
    boom = HostRequestFailed("HOST_TIMEOUT", "host.executeTool 请求超时")
    engine, _, _, _ = make_engine([boom], [])
    # 系统级故障要冒到 run()：channel 已经不可信，继续循环没有意义。
    with pytest.raises(HostRequestFailed):
        engine._execute(tool_call())


def test_execute_lets_channel_closed_propagate():
    engine, _, _, _ = make_engine([HostChannelClosed("stdin 关闭")], [])
    with pytest.raises(HostChannelClosed):
        engine._execute(tool_call())


# ---- run：摘要页码校验的接线 ----


def test_run_rejects_page_ref_that_was_never_extracted():
    engine, _, _, _ = make_engine(
        [list_result(), pdf_result()],
        [
            tool_call(call_id="c-1"),
            tool_call(call_id="c-2", capability="document.extract_pdf", path="D:/a.pdf"),
            SummaryDecision(
                kind="summary", facts=[{"text": "编的", "pageRefs": [9999]}]
            ),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    # Exit Checklist「虚假页码被 SummaryVerifier 拒绝」在 loop 层的落点。
    assert isinstance(outcome, RunTaskFailed)
    assert outcome.events[-1].type == EVENT_TASK_FAILED
    assert outcome.reason


def test_run_rejects_summary_when_nothing_was_extracted():
    engine, _, _, _ = make_engine(
        [list_result()],
        [
            tool_call(call_id="c-1"),
            SummaryDecision(kind="summary", facts=[{"text": "结论", "pageRefs": [1]}]),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    # 只 list 没 extract：参照集合为空，任何页码引用都无处核对。
    assert isinstance(outcome, RunTaskFailed)
    assert outcome.reason


def test_run_failed_extract_contributes_no_pages():
    engine, _, _, _ = make_engine(
        [{"ok": False, "code": "FILE_UNREADABLE", "reason": "PDF 已加密"}],
        [
            tool_call(
                call_id="c-1", capability="document.extract_pdf", path="D:/bad.pdf"
            ),
            SummaryDecision(kind="summary", facts=[{"text": "结论", "pageRefs": [1]}]),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    # 提取失败却贡献页码，等于给模型发通行证。
    assert isinstance(outcome, RunTaskFailed)


def test_run_accepts_page_ref_from_a_second_extract():
    engine, _, _, _ = make_engine(
        [
            {"ok": True, "pages": [{"pageNumber": 1, "text": "第一份"}]},
            {"ok": True, "pages": [{"pageNumber": 4, "text": "第二份"}]},
        ],
        [
            tool_call(call_id="c-1", capability="document.extract_pdf", path="D:/a.pdf"),
            tool_call(call_id="c-2", capability="document.extract_pdf", path="D:/b.pdf"),
            SummaryDecision(kind="summary", facts=[{"text": "结论", "pageRefs": [4]}]),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    # 参照集合是并集：第二份 PDF 的页码同样可引。
    assert isinstance(outcome, RunTaskCompleted)
    assert outcome.facts[0].pageRefs == [4]


# ---- run：主循环 ----


def test_run_golden_path_completes():
    engine, model, channel, _ = make_engine(
        [list_result(), pdf_result()], golden_path()
    )
    outcome = engine.run("整理 Downloads 里的 PDF", VISIBLE)
    assert isinstance(outcome, RunTaskCompleted)
    assert outcome.status == "completed"
    assert len(outcome.facts) == 1
    assert outcome.facts[0].pageRefs == [1]
    assert len(channel.calls) == 2
    assert model.remaining == 0


def test_run_event_order_on_golden_path():
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)
    assert [e.type for e in outcome.events] == [
        EVENT_TASK_STARTED,
        EVENT_TOOL_CALLED,
        EVENT_TOOL_RESULT,
        EVENT_TOOL_CALLED,
        EVENT_TOOL_RESULT,
        EVENT_TASK_COMPLETED,
    ]


def test_run_task_started_payload_carries_goal():
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("整理 Downloads 里的 PDF", VISIBLE)
    assert outcome.events[0].payload == {"goal": "整理 Downloads 里的 PDF"}


def _completed_payload(outcome):
    """走 runtime.py 同一条序列化路径取 payload。

    钉的是上线的 JSON 形状，不是 payload 属性里可能还挂着的 SummaryFact 实例：
    RunTaskEvent.payload 声明是 Any，塞模型实例还是塞普通 dict 都能过契约，
    但 TS 那边看到的只能是 model_dump 之后的形状。
    """
    return outcome.events[-1].model_dump()["payload"]


def test_run_task_completed_payload_carries_fact_count_and_facts():
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)

    assert _completed_payload(outcome) == {
        "factCount": 1,
        "facts": [{"text": "摘要", "pageRefs": [1]}],
    }


def test_run_task_completed_payload_keeps_fact_count_alongside_facts():
    # TS 侧 summarizePayload 的 task_completed 分支只认 factCount。
    # 只发 facts 不发 factCount，timeline 那行会退化成整段 JSON。
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    payload = _completed_payload(engine.run("g", VISIBLE))

    assert "factCount" in payload
    assert payload["factCount"] == len(payload["facts"])


def test_run_task_completed_payload_facts_match_the_verified_ones():
    # 进 payload 的必须是 verify_summary 之后的结果，不是模型原样交上来的那份。
    # 两者在 golden path 上看着一样，差别在页码被强转或补全的时候才出来。
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)

    assert _completed_payload(outcome)["facts"] == [f.model_dump() for f in outcome.facts]


def test_run_task_completed_payload_carries_every_fact_not_just_the_first():
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="document.extract_pdf",
            arguments={"path": "D:/downloads/a.pdf"},
        ),
        SummaryDecision(
            kind="summary",
            facts=[
                {"text": "第一条", "pageRefs": [1]},
                {"text": "第二条", "pageRefs": [1]},
            ],
        ),
    ]
    engine, *_ = make_engine([list_result(), pdf_result()], decisions)

    assert _completed_payload(engine.run("g", VISIBLE))["facts"] == [
        {"text": "第一条", "pageRefs": [1]},
        {"text": "第二条", "pageRefs": [1]},
    ]


def test_run_task_completed_payload_survives_json_dumps():
    # runtime.py 是 model_dump() 之后交给 json.dumps 的。payload 声明是 Any，
    # 直接塞 SummaryFact 实例能不能过这一关，取决于 pydantic 会不会递归进 Any。
    # 不递归的话这里是 TypeError，整个 run_task 响应发不出去。
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)

    text = json.dumps(outcome.model_dump(), ensure_ascii=False)

    assert json.loads(text)["events"][-1]["payload"]["facts"] == [
        {"text": "摘要", "pageRefs": [1]}
    ]


def test_run_all_occurred_at_match_contract():
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)
    pattern = re.compile(OCCURRED_AT_PATTERN)
    for event in outcome.events:
        assert pattern.match(event.occurredAt), event.type


def test_run_records_observations_in_order():
    engine, _, _, context = make_engine([list_result(), pdf_result()], golden_path())
    engine.run("g", VISIBLE)
    recorded = context.observations
    assert [o.callId for o in recorded] == ["c-1", "c-2"]
    assert [o.capability for o in recorded] == VISIBLE
    assert all(o.ok for o in recorded)


def test_run_first_decision_sees_empty_observations():
    engine, model, _, _ = make_engine([list_result(), pdf_result()], golden_path())
    engine.run("g", VISIBLE)
    # Golden Path 第一步就是空历史，build 不能抛。
    assert model.receivedContexts[0].observations == []
    assert len(model.receivedContexts[1].observations) == 1


def test_run_visible_capabilities_reach_model():
    engine, model, _, _ = make_engine([list_result(), pdf_result()], golden_path())
    engine.run("g", VISIBLE)
    # Exit Checklist 第 3 条：Agent 只能看到 Scope 里的能力。
    for ctx in model.receivedContexts:
        assert ctx.visibleCapabilities == VISIBLE
        assert ctx.taskGoal == "g"


def test_run_truncates_before_feeding_model():
    engine, model, _, context = make_engine(
        [pdf_result(text="x" * 5000)],
        [
            tool_call(call_id="c-1", capability="document.extract_pdf", path="D:/a.pdf"),
            SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
        ],
        maxCharsPerString=10,
    )
    engine.run("g", VISIBLE)
    # 存的是原样（决定 2），喂给模型的是截断过的（3c）。
    assert len(context.observations[0].payload["pages"][0]["text"]) == 5000
    fed = model.receivedContexts[1].observations[0].payload["pages"][0]
    assert fed["text"].endswith("…[truncated]")
    assert fed["pageNumber"] == 1


def test_run_ok_false_is_fed_back_and_loop_continues():
    engine, _, _, context = make_engine(
        [
            {"ok": False, "code": "FILE_UNREADABLE", "reason": "PDF 已加密"},
            pdf_result(),
        ],
        [
            tool_call(call_id="c-1", capability="document.extract_pdf", path="D:/bad.pdf"),
            tool_call(call_id="c-2", capability="document.extract_pdf", path="D:/a.pdf"),
            SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    # 决定 6：业务失败不是异常，模型得知道这条路走不通才会换。
    assert isinstance(outcome, RunTaskCompleted)
    assert context.observations[0].ok is False
    assert context.observations[0].payload["code"] == "FILE_UNREADABLE"
    assert context.observations[1].ok is True


def test_run_steps_budget_exhausted_emits_two_events():
    engine, _, _, _ = make_engine(
        [list_result(), list_result(), list_result()],
        [
            tool_call(call_id="c-1"),
            tool_call(call_id="c-2"),
            tool_call(call_id="c-3"),
        ],
        budget=Budget(maxSteps=2, maxToolCalls=9),
    )
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    assert [e.type for e in outcome.events][-2:] == [
        EVENT_BUDGET_EXHAUSTED,
        EVENT_TASK_FAILED,
    ]
    # UI 靠 budget_exhausted 区分「跑不完」和「跑错了」，
    # 只有 task_failed 的话这两种在 timeline 上长得一样。
    assert outcome.events[-2].payload == {"steps": 2, "toolCalls": 2}


def test_run_tool_call_budget_is_a_separate_dimension():
    engine, _, channel, _ = make_engine(
        [list_result(), list_result(), list_result()],
        [tool_call(call_id="c-1"), tool_call(call_id="c-2"), tool_call(call_id="c-3")],
        budget=Budget(maxSteps=8, maxToolCalls=1),
    )
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    # steps 还剩很多，但 toolCalls 到顶了。两维是 or 不是 and。
    assert len(channel.calls) == 1
    assert outcome.events[-2].payload == {"steps": 1, "toolCalls": 1}


def test_run_summary_rejected_fails_task():
    engine, _, _, _ = make_engine(
        [list_result()],
        [
            tool_call(call_id="c-1"),
            SummaryDecision(kind="summary", facts=[{"text": "", "pageRefs": [1]}]),
        ],
    )
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    assert outcome.reason
    assert outcome.events[-1].type == EVENT_TASK_FAILED
    # 失败的 task 不该同时带 facts 字段，那是 completed 分支的形状。
    assert not hasattr(outcome, "facts")


def test_run_host_request_failed_fails_task_with_code():
    engine, _, _, _ = make_engine(
        [HostRequestFailed("HOST_TIMEOUT", "host.executeTool 请求超时 (5000ms)")],
        [tool_call(call_id="c-1")],
    )
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    assert "HOST_TIMEOUT" in outcome.reason
    # 已经攒的 events 必须一起回传，那是 timeline 的唯一来源。
    assert [e.type for e in outcome.events] == [
        EVENT_TASK_STARTED,
        EVENT_TOOL_CALLED,
        EVENT_TASK_FAILED,
    ]


def test_run_channel_closed_fails_task():
    engine, _, _, _ = make_engine(
        [HostChannelClosed("stdin 关闭")], [tool_call(call_id="c-1")]
    )
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    assert outcome.reason
    assert outcome.events[-1].type == EVENT_TASK_FAILED


def test_run_script_exhausted_fails_task_instead_of_crashing():
    engine, _, _, _ = make_engine(
        [list_result(), list_result()],
        [tool_call(call_id="c-1")],
        budget=Budget(maxSteps=5, maxToolCalls=5),
    )
    # 脚本只有一条决策但预算给到 5 步，第二次 decide 会抛 ScriptExhausted。
    # 不接住的话 traceback 上 stdout 是空的，TS 侧只能等满 30 秒超时。
    outcome = engine.run("g", VISIBLE)
    assert isinstance(outcome, RunTaskFailed)
    assert outcome.events[-1].type == EVENT_TASK_FAILED


def test_run_immediate_summary_without_tools_fails():
    engine, _, channel, _ = make_engine(
        [], [SummaryDecision(kind="summary", facts=[{"text": "无需工具", "pageRefs": []}])]
    )
    outcome = engine.run("g", VISIBLE)
    # REQ-007 的判定者到位了：一页都没提取过，pageRefs 还是空的，两条都不过。
    assert isinstance(outcome, RunTaskFailed)
    assert channel.calls == []
    assert [e.type for e in outcome.events] == [
        EVENT_TASK_STARTED,
        EVENT_TASK_FAILED,
    ]


def test_run_returns_protocol_models_not_dicts():
    engine, *_ = make_engine([list_result(), pdf_result()], golden_path())
    outcome = engine.run("g", VISIBLE)
    # runtime 那边直接 outcome.model_dump() 包 envelope，
    # 返回 dict 的话就没法用 RunTaskResult 的判别联合校验了。
    assert isinstance(outcome, (RunTaskCompleted, RunTaskFailed))
    assert outcome.model_dump()["status"] == "completed"
