import json
from pathlib import Path

from personal_agent.model_gateway import SummaryDecision, ToolCallDecision
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolResult,
    MakePlanResponse,
    RunTaskResponse,
)
from personal_agent.runtime import (
    PLAN_NOT_BUILDABLE,
    RUNTIME_MODEL_NOT_CONFIGURED,
    SCRIPT_ENV,
    RuntimeDeps,
    handle_line,
    resolve_model_factory,
)
from personal_agent.scripted_model import ScriptedModel, load_script
from personal_agent.summary import EXTRACT_PDF_CAPABILITY

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_SCRIPT = REPO_ROOT / "tests" / "fixtures" / "scripts" / "golden-path.json"


class StubChannel:
    """按 capability 分派一个够用的结果。

    以前对所有 capability 都回 {ok:true, entries:[]}，那时 runtime 层的测试
    确实不关心 host 结果的内容。TASK-014 之后不一样了：SummaryVerifier 要从
    extract_pdf 的 payload.pages 里挖页码当参照集合，host 结果的内容第一次
    成了 runtime 层测试的依赖。engine 的分派逻辑仍在 test_engine.py 里用
    可控的 FakeChannel 测。
    """

    def call_host(self, params):
        if params.capability == EXTRACT_PDF_CAPABILITY:
            return HostExecuteToolResult.model_validate(
                {"ok": True, "pages": [{"pageNumber": 1, "text": "第一页正文"}]}
            )
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
    },
    {
        "name": EXTRACT_PDF_CAPABILITY,
        "kind": "READ",
        "description": "提取 PDF 的逐页文本",
    },
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


def make_plan_line(req_id="20", task_id="task-001", goal="整理 Downloads 里的 PDF"):
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "agent.make_plan",
            "params": {"taskId": task_id, "goal": goal},
        }
    )


class RecordingFactory:
    """每次 run_task 造一个新 ScriptedModel，造出来的都留着给断言看。

    存工厂之后测试拿不到 model 实例了，而 receivedContexts 是验证
    visibleCapabilities 一路通到模型的唯一窗口，所以记下来。
    """

    def __init__(self, decisions):
        self.decisions = decisions
        self.instances = []

    def __call__(self):
        model = ScriptedModel(self.decisions)
        self.instances.append(model)
        return model


def deps_with(decisions=None):
    factory = None if decisions is None else RecordingFactory(decisions)
    return RuntimeDeps(channel=StubChannel(), model_factory=factory)


def deps_with_factory(factory):
    return RuntimeDeps(channel=StubChannel(), model_factory=factory)


def write_script(tmp_path, payload=None):
    """把剧本落盘。payload 传字符串就是写坏文件用的。"""
    if payload is None:
        payload = [d.model_dump() for d in golden_path()]
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    path = tmp_path / "script.json"
    path.write_text(text, encoding="utf-8")
    return path


def golden_path():
    """TASK-013 Validation 要求的 list→extract→summary 三步。

    以前只有两步（list 之后直接 summary），摘要不核页码所以看不出缺。
    参照集合到位之后，没调 extract_pdf 就没有任何合法页码可引。
    """
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
            capability=EXTRACT_PDF_CAPABILITY,
            arguments={"path": "D:/downloads/a.pdf"},
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
    assert [c.name for c in deps.capabilities] == [
        "filesystem.list",
        EXTRACT_PDF_CAPABILITY,
    ]
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
        run_task_line(goal=""), deps_with(golden_path())
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
    resp = handle_line(line, deps_with(golden_path()))
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"


def test_run_task_unexpected_error_returns_runtime_internal():
    # engine.run 只接住它自己列的那几种异常。别的冒上来时必须转成协议错误：
    # 不转的话 traceback 走 stderr、stdout 一个字没有，TS 侧只能干等 120 秒超时。
    resp = handle_line(run_task_line(), deps_with_factory(lambda: ExplodingModel()))

    assert resp["error"]["code"] == "RUNTIME_INTERNAL"
    assert resp["id"] == "30"


def test_run_task_returns_envelope_that_matches_contract():
    deps = deps_with(golden_path())
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
    factory = RecordingFactory(golden_path())
    deps = deps_with_factory(factory)
    handle_line(initialize_line(), deps)
    handle_line(run_task_line(), deps)

    assert factory.instances[0].receivedContexts
    for ctx in factory.instances[0].receivedContexts:
        assert ctx.visibleCapabilities == ["filesystem.list", EXTRACT_PDF_CAPABILITY]
        assert ctx.taskGoal == "整理 Downloads 里的 PDF"


def test_run_task_without_initialize_gives_model_no_capabilities():
    # 没握手就跑任务不是错误，但模型什么工具都看不到，
    # 自然会在预算里耗尽 —— 不需要额外拦一道。
    factory = RecordingFactory(golden_path())
    deps = deps_with_factory(factory)
    resp = handle_line(run_task_line(), deps)
    RunTaskResponse.model_validate(resp)
    for ctx in factory.instances[0].receivedContexts:
        assert ctx.visibleCapabilities == []


def test_run_task_events_do_not_carry_task_id():
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)
    resp = handle_line(run_task_line(task_id="task-777"), deps)

    # 3b 钉死的：RunTaskEvent 只有 type / payload / occurredAt。
    # 带上 taskId 就允许 Python 把事件回到别的任务上，
    # 而那个 id 恰好存在时 DB 外键不会拦，Timeline 会静默串任务。
    for event in resp["result"]["events"]:
        assert set(event) == {"type", "payload", "occurredAt"}
        assert "task-777" not in json.dumps(event, ensure_ascii=False)


def test_run_task_uses_a_fresh_context_per_task():
    factory = RecordingFactory(golden_path())
    deps = deps_with_factory(factory)
    handle_line(initialize_line(), deps)
    handle_line(run_task_line(req_id="40"), deps)
    second = handle_line(run_task_line(req_id="41"), deps)

    # 第二个任务的第一步必须看到空历史，否则上一个任务的观察会串进来。
    # 这里以前要喂双份剧本，因为一个实例的游标是跨任务接着走的；
    # 换成工厂之后每任务一个新实例，三步剧本跑两次刚好。
    assert second["result"]["status"] == "completed"
    assert len(factory.instances) == 2
    assert factory.instances[1].receivedContexts[0].observations == []


def test_run_task_engine_failure_does_not_leak_traceback():
    # ScriptExhausted 要在 engine 里接住。不接的话它冒到 dispatch，
    # stdout 一个字节都没有，TS 侧只能等满 30 秒超时（GUD-003）。
    deps = deps_with([])
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


# ====== 连续 20 次（REQ-010 / TEST-012）======


def test_run_task_twenty_times_in_a_row_all_complete():
    # 三步剧本配一个实例只够跑一次。这条钉的是每任务换一个工厂产物，
    # 存实例的话第 2 次就开始 ScriptExhausted，20 次里 19 次失败。
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    statuses = [
        handle_line(run_task_line(req_id=str(40 + i)), deps)["result"]["status"]
        for i in range(20)
    ]

    assert statuses == ["completed"] * 20


def test_run_task_twenty_times_facts_are_identical_every_round():
    # 确定性链路的意思不只是「都跑完」，还有「每次结果一样」。
    # 游标或 observations 泄漏会让后面的轮次拿到不同的上下文，fact 就飘了。
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    facts = [
        handle_line(run_task_line(req_id=str(60 + i)), deps)["result"]["facts"]
        for i in range(20)
    ]

    assert facts == [facts[0]] * 20


def test_model_factory_is_called_exactly_once_per_task():
    factory = RecordingFactory(golden_path())
    deps = deps_with_factory(factory)
    handle_line(initialize_line(), deps)
    handle_line(run_task_line(req_id="40"), deps)
    handle_line(run_task_line(req_id="41"), deps)

    assert len(factory.instances) == 2


# ====== 剧本装配（TASK-016）======


def test_resolve_model_factory_returns_none_without_env(monkeypatch):
    # 生产默认不配模型，收到 run_task 回 RUNTIME_MODEL_NOT_CONFIGURED。
    monkeypatch.delenv(SCRIPT_ENV, raising=False)
    assert resolve_model_factory() is None


def test_resolve_model_factory_builds_a_fresh_model_per_call(monkeypatch, tmp_path):
    monkeypatch.setenv(SCRIPT_ENV, str(write_script(tmp_path)))
    factory = resolve_model_factory()

    assert factory is not None
    first, second = factory(), factory()
    assert isinstance(first, ScriptedModel)
    assert first is not second
    assert first.remaining == second.remaining == 3


def test_resolve_model_factory_returns_none_when_script_is_broken(monkeypatch, tmp_path):
    # 剧本坏了不能让进程起不来：握手与 ping 都得照常，
    # 只是 run_task 回 NOT_CONFIGURED。抛出去的话整个 runtime 启不了。
    monkeypatch.setenv(SCRIPT_ENV, str(tmp_path / "不存在.json"))
    assert resolve_model_factory() is None


def test_resolve_model_factory_returns_none_when_script_is_not_json(monkeypatch, tmp_path):
    monkeypatch.setenv(SCRIPT_ENV, str(write_script(tmp_path, "{ 这不是 JSON")))
    assert resolve_model_factory() is None


def test_resolve_model_factory_reads_the_repo_fixture(monkeypatch):
    # 把 tests/fixtures/scripts/golden-path.json 钉进链路：TS 侧 E2E 指的就是这份，
    # 形状错了要先在这儿红，而不是在跑了一整个子进程之后。
    assert FIXTURE_SCRIPT.exists(), f"缺剧本 fixture: {FIXTURE_SCRIPT}"
    monkeypatch.setenv(SCRIPT_ENV, str(FIXTURE_SCRIPT))
    factory = resolve_model_factory()

    assert factory is not None
    assert factory().remaining == 3


def test_fixture_script_is_the_read_only_golden_path():
    decisions = load_script(FIXTURE_SCRIPT)

    assert [d.kind for d in decisions] == ["tool_call", "tool_call", "summary"]
    assert decisions[0].capability == "filesystem.list"
    assert decisions[1].capability == EXTRACT_PDF_CAPABILITY
    # 页码只能用 1/2/3：固定 PDF 就三页，引用到第 4 页会被 SummaryVerifier 拒掉。
    assert decisions[2].facts[0]["pageRefs"] == [1]
    assert decisions[2].facts[1]["pageRefs"] == [2, 3]


# ---- agent.make_plan ----
EXPECTED_PLAN_CAPABILITIES = ["filesystem.list", EXTRACT_PDF_CAPABILITY]


def test_make_plan_returns_the_three_step_plan_after_initialize():
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    out = handle_line(make_plan_line(), deps)

    steps = out["result"]["steps"]
    assert [s.get("capability") for s in steps] == [*EXPECTED_PLAN_CAPABILITIES, None]
    assert [s["description"] for s in steps] == [
        "列出 Downloads 下的 PDF",
        "提取目标 PDF 的每页文本",
        "基于页面内容生成带页码引用的摘要",
    ]


def test_make_plan_response_matches_the_contract():
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    MakePlanResponse.model_validate(handle_line(make_plan_line(), deps))


def test_make_plan_summary_step_has_no_capability_key_at_all():
    """zod 的 optional 不收 null，所以这里不能只是值为 None，键必须不存在。"""
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    steps = handle_line(make_plan_line(), deps)["result"]["steps"]

    assert "capability" not in steps[2]
    assert json.dumps(steps[2], ensure_ascii=False).find("capability") == -1


def test_make_plan_does_not_need_a_model():
    """计划是确定性的，没配剧本的进程也得能回答；只有 run_task 才拦模型。"""
    deps = deps_with(None)
    handle_line(initialize_line(), deps)

    out = handle_line(make_plan_line(), deps)

    assert "error" not in out
    assert len(out["result"]["steps"]) == 3


def test_make_plan_is_deterministic_across_calls():
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)

    first = handle_line(make_plan_line(), deps)["result"]
    second = handle_line(make_plan_line(req_id="21"), deps)["result"]

    assert first == second


def test_make_plan_without_initialize_returns_plan_not_buildable():
    """没握手就没有可见能力清单，计划不该凭空承诺两个 READ。"""
    out = handle_line(make_plan_line(), deps_with(golden_path()))

    assert out["error"]["code"] == PLAN_NOT_BUILDABLE


def test_make_plan_without_deps_returns_plan_not_buildable():
    out = handle_line(make_plan_line())

    assert out["error"]["code"] == PLAN_NOT_BUILDABLE


def test_make_plan_error_names_the_missing_capability():
    """只说「建不出来」没用：得知道是 Scope 少了哪个能力。"""
    only_list = [CAPABILITIES[0]]
    deps = deps_with(golden_path())
    handle_line(initialize_line(capabilities=only_list), deps)

    out = handle_line(make_plan_line(), deps)

    assert out["error"]["code"] == PLAN_NOT_BUILDABLE
    assert EXTRACT_PDF_CAPABILITY in out["error"]["message"]


def test_make_plan_invalid_params_returns_protocol_error():
    deps = deps_with(golden_path())
    handle_line(initialize_line(), deps)
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "22",
            "method": "agent.make_plan",
            "params": {"taskId": "task-001"},
        }
    )

    out = handle_line(line, deps)

    assert out["error"]["code"] == "PROTOCOL_INVALID_REQUEST"


def test_make_plan_wrong_version_initialize_does_not_leak_capabilities():
    """握手版本不对时 deps.capabilities 不会被写，计划也就建不出来。"""
    deps = deps_with(golden_path())
    handle_line(initialize_line(version="9.9"), deps)

    out = handle_line(make_plan_line(), deps)

    assert out["error"]["code"] == PLAN_NOT_BUILDABLE
