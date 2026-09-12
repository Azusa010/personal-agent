import json

from personal_agent.model_gateway import SummaryDecision, ToolCallDecision
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolResult,
    RunTaskResponse,
)
from personal_agent.runtime import (
    RUNTIME_MODEL_NOT_CONFIGURED,
    RuntimeDeps,
    handle_line,
)
from personal_agent.scripted_model import ScriptedModel


class StubChannel:
    """runtime 层的测试不关心 host 结果的内容，只要 call_host 不炸。

    engine 的分派逻辑在 test_engine.py 里用可控的 FakeChannel 测，
    这里再控一遗就是两份需要同步的假件。
    """

    def call_host(self, params):
        return HostExecuteToolResult.model_validate({"ok": True, "entries": []})


class ExplodingModel:
    """兜底路径用的假模型：抛一个 engine.run 不认识的异常。"""

    def decide(self, context):
        raise RuntimeError("模型适配器炸了")


CAPABILITIES = [
    {
        "name": "filesystem.list",
        "kind": "READ",
        "description": "列出授权根目录下的条目",
    }
]


def initialize_line(req_id="10", capabilities=None, version="0.1"):
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "system.initialize",
            "params": {
                "protocolVersion": version,
                "capabilities": CAPABILITIES if capabilities is None else capabilities,
                "client": {"name": "personal-agent-electron", "version": "0.1.0"},
            },
        }
    )


def run_task_line(req_id="30", task_id="task-001", goal="整理 Downloads 里的 PDF"):
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "agent.run_task",
            "params": {"taskId": task_id, "goal": goal},
        }
    )


def deps_with(model=None):
    return RuntimeDeps(channel=StubChannel(), model=model)


def golden_path():
    return [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
    ]


def test_ping_returns_empty_result():
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "1", "method": "system.ping", "params": {}}
    )
    assert handle_line(line) == {"jsonrpc": "2.0", "id": "1", "result": {}}


def test_unknown_method_returns_error():
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "2", "method": "system.nope", "params": {}}
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "METHOD_NOT_FOUND"
    assert resp["id"] == "2"


def test_invalid_json_returns_parse_error():
    resp = handle_line("{not json")
    assert resp["error"]["code"] == "PROTOCOL_INVALID_JSON"
    assert resp["id"] is None


def test_blank_line_returns_none():
    assert handle_line("   ") is None


def test_initialize_returns_server_info():
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "10",
            "method": "system.initialize",
            "params": {
                "protocolVersion": "0.1",
                "capabilities": [
                    {
                        "name": "filesystem.list",
                        "kind": "READ",
                        "description": "列出授权根目录下的条目",
                    }
                ],
                "client": {"name": "personal-agent-electron", "version": "0.1.0"},
            },
        }
    )
    resp = handle_line(line)
    assert resp["result"]["protocolVersion"] == "0.1"
    assert resp["result"]["server"]["name"] == "personal-agent-runtime"
    assert resp["result"]["server"]["version"] == "0.1.0"


def test_initialize_stores_capabilities_into_deps():
    # 3a 把 capabilities 打通到了 wire，但 handle_initialize 把
    # model_validate 的返回值丢掉了，链路断在最后一米。这条钉住它接上了。
    deps = deps_with()
    assert deps.capabilities == []
    handle_line(initialize_line(), deps)
    assert [c.name for c in deps.capabilities] == ["filesystem.list"]
    assert isinstance(deps.capabilities[0], CapabilityDescriptor)


def test_initialize_without_deps_still_returns_result():
    # 现有七条测试都是无状态直调，deps 默认 None 不能把它们弄红。
    resp = handle_line(initialize_line())
    assert resp["result"]["protocolVersion"] == "0.1"


def test_initialize_wrong_version_does_not_touch_deps():
    deps = deps_with()
    handle_line(initialize_line(version="0.2"), deps)
    # 校验失败就不能写状态，否则下一次 run_task 拿到的是半个握手。
    assert deps.capabilities == []


# ---- agent.run_task ----


def test_run_task_without_deps_returns_model_not_configured():
    resp = handle_line(run_task_line())
    assert resp["error"]["code"] == RUNTIME_MODEL_NOT_CONFIGURED
    assert resp["id"] == "30"


def test_run_task_without_model_returns_model_not_configured():
    # main() 起的进程就是这个状态：真实模型 adapter 还不存在（PAT-004）。
    # 回一个明确的码，而不是拿空脚本的 ScriptedModel 去跑然后立即耗尽。
    resp = handle_line(run_task_line(), deps_with())
    assert resp["error"]["code"] == RUNTIME_MODEL_NOT_CONFIGURED


def test_run_task_invalid_params_returns_protocol_error():
    resp = handle_line(
        run_task_line(goal=""), deps_with(ScriptedModel(golden_path()))
    )
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"


def test_run_task_missing_goal_returns_protocol_error():
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "31",
            "method": "agent.run_task",
            "params": {"taskId": "task-001"},
        }
    )
    resp = handle_line(line, deps_with(ScriptedModel(golden_path())))
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"


def test_run_task_unexpected_error_returns_runtime_internal():
    # engine.run 只接住它自己列的那几种异常。别的冒上来时必须转成协议错误：
    # 不转的话 traceback 走 stderr、stdout 一个字没有，TS 侧只能干等 120 秒超时。
    resp = handle_line(run_task_line(), deps_with(ExplodingModel()))

    assert resp["error"]["code"] == "RUNTIME_INTERNAL"
    assert resp["id"] == "30"


def test_run_task_returns_envelope_that_matches_contract():
    model = ScriptedModel(golden_path())
    deps = deps_with(model)
    handle_line(initialize_line(), deps)
    resp = handle_line(run_task_line(), deps)

    assert resp["id"] == "30"
    assert "error" not in resp
    # 双端镜像：这个 dict 就是 TS 侧 RunTaskResponse.parse 要吃的东西。
    RunTaskResponse.model_validate(resp)
    assert resp["result"]["status"] == "completed"
    assert resp["result"]["facts"] == [{"text": "摘要", "pageRefs": [1]}]


def test_run_task_capabilities_from_initialize_reach_model():
    # Exit Checklist 第 3 条的活体验证：initialize 下发的清单要一路走到
    # ModelContext.visibleCapabilities，中间不能断也不能多。
    model = ScriptedModel(golden_path())
    deps = deps_with(model)
    handle_line(initialize_line(), deps)
    handle_line(run_task_line(), deps)

    assert model.receivedContexts
    for ctx in model.receivedContexts:
        assert ctx.visibleCapabilities == ["filesystem.list"]
        assert ctx.taskGoal == "整理 Downloads 里的 PDF"


def test_run_task_without_initialize_gives_model_no_capabilities():
    # 没握手就跑任务不是错误，但模型什么工具都看不到，
    # 自然会在预算里耗尽 —— 不需要额外拦一道。
    model = ScriptedModel(golden_path())
    deps = deps_with(model)
    resp = handle_line(run_task_line(), deps)
    RunTaskResponse.model_validate(resp)
    for ctx in model.receivedContexts:
        assert ctx.visibleCapabilities == []


def test_run_task_events_do_not_carry_task_id():
    model = ScriptedModel(golden_path())
    deps = deps_with(model)
    handle_line(initialize_line(), deps)
    resp = handle_line(run_task_line(task_id="task-777"), deps)

    # 3b 钉死的：RunTaskEvent 只有 type / payload / occurredAt。
    # 带上 taskId 就允许 Python 把事件回到别的任务上，
    # 而那个 id 恰好存在时 DB 外键不会拦，Timeline 会静默串任务。
    for event in resp["result"]["events"]:
        assert set(event) == {"type", "payload", "occurredAt"}
        assert "task-777" not in json.dumps(event, ensure_ascii=False)


def test_run_task_uses_a_fresh_context_per_task():
    model = ScriptedModel(golden_path() + golden_path())
    deps = deps_with(model)
    handle_line(initialize_line(), deps)
    handle_line(run_task_line(req_id="40"), deps)
    second = handle_line(run_task_line(req_id="41"), deps)

    # 第二个任务的第一步必须看到空历史，否则上一个任务的观察会串进来。
    assert second["result"]["status"] == "completed"
    assert model.receivedContexts[2].observations == []


def test_run_task_engine_failure_does_not_leak_traceback():
    # ScriptExhausted 要在 engine 里接住。不接的话它冒到 dispatch，
    # stdout 一个字节都没有，TS 侧只能等满 30 秒超时（GUD-003）。
    deps = deps_with(ScriptedModel([]))
    handle_line(initialize_line(), deps)
    resp = handle_line(run_task_line(), deps)
    assert "error" not in resp
    assert resp["result"]["status"] == "failed"
    RunTaskResponse.model_validate(resp)


def test_initialize_wrong_version_returns_error():
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "11",
            "method": "system.initialize",
            "params": {
                "protocolVersion": "0.2",
                # 能力清单必须齐全，否则这条测的就不是“版本不匹配”
                # 而是“缺字段”，两个失败原因叠在一起看不出钉的是哪个。
                "capabilities": [
                    {
                        "name": "filesystem.list",
                        "kind": "READ",
                        "description": "列出授权根目录下的条目",
                    }
                ],
                "client": {"name": "personal-agent-electron", "version": "0.1.0"},
            },
        }
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"
    assert resp["id"] == "11"


def test_filesystem_list_is_not_a_python_method():
    # 执行体已移到 TS 侧 executor，它只是 host.execute_tool 的一个 capability。
    # Python 再收到这个 method 就是调用方搞错了方向。
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "20",
            "method": "filesystem.list",
            "params": {"rootId": "downloads"},
        }
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "METHOD_NOT_FOUND"
    assert resp["id"] == "20"
