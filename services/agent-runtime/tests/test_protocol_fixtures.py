import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from personal_agent.protocol.models import (
    CapabilityFailure,
    DocumentExtractPdfParams,
    DocumentExtractPdfResult,
    FilesystemListParams,
    FilesystemListResult,
    HostExecuteToolParams,
    HostExecuteToolRequest,
    HostExecuteToolResponse,
    InitializeParams,
    InitializeResult,
    MakePlanParams,
    MakePlanRequest,
    MakePlanResponse,
    MakePlanResult,
    PlanStepDto,
    Request,
    Response,
    RunTaskEvent,
    RunTaskParams,
    RunTaskRequest,
    RunTaskResponse,
    RunTaskResult,
    SummaryFact,
)

FIXTURES_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "protocol" / "fixtures"
)


def _load(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def _pick(raw: dict, path: str):
    """按点路径取嵌套字段。

    capability 的 arguments 住在 params.arguments 里，一层下标拿不到。
    取不到就直接 fail，不要让后面的 model_validate 收到 None 再报一个
    指向错误现场的 ValidationError。
    """
    node: object = raw
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            pytest.fail(f"fixture 里取不到字段 {path}")
        node = node[key]
    return node


# 与 packages/protocol/tests/envelope.test.ts 的 legalCases 一一对应。
# 两边条目数或 field 不一致，说明有一侧偷偷放宽了，这里就是抓漂移的地方。
@pytest.mark.parametrize(
    ("name", "envelope", "payload", "field"),
    [
        ("initialize.request.json", Request, InitializeParams, "params"),
        ("initialize.response.json", Response, InitializeResult, "result"),
        ("ping.request.json", Request, None, "params"),
        ("ping.response.json", Response, None, "result"),
        # filesystem.list 不再是 TS→Python 的独立 method（执行体已移到 host 侧），
        # 它的 params/result 挂在 host.execute_tool 的 arguments/result 上。
        (
            "host-filesystem-list.request.json",
            HostExecuteToolRequest,
            HostExecuteToolParams,
            "params",
        ),
        (
            "host-filesystem-list.request.json",
            HostExecuteToolRequest,
            FilesystemListParams,
            "params.arguments",
        ),
        # FilesystemListResult 只钉 entries。host result 里的 ok 会被默认
        # extra='ignore' 丢掉，ok 由 envelope 层的 HostExecuteToolResult 负责。
        (
            "host-filesystem-list.response.json",
            HostExecuteToolResponse,
            FilesystemListResult,
            "result",
        ),
        (
            "host-execute-tool.request.json",
            HostExecuteToolRequest,
            HostExecuteToolParams,
            "params",
        ),
        (
            "host-execute-tool.request.json",
            HostExecuteToolRequest,
            DocumentExtractPdfParams,
            "params.arguments",
        ),
        (
            "host-execute-tool.response.json",
            HostExecuteToolResponse,
            DocumentExtractPdfResult,
            "result",
        ),
        # 业务失败（PDF 损坏等）走 result 不走 error，形状由 CapabilityFailure 钉。
        (
            "host-execute-tool.failure.response.json",
            HostExecuteToolResponse,
            CapabilityFailure,
            "result",
        ),
        (
            "agent-make-plan.request.json",
            MakePlanRequest,
            MakePlanParams,
            "params",
        ),
        # result 已经是强类型的 MakePlanResult，envelope 校验会递归到 steps。
        (
            "agent-make-plan.response.json",
            MakePlanResponse,
            None,
            "result",
        ),
        (
            "agent-run-task.request.json",
            RunTaskRequest,
            RunTaskParams,
            "params",
        ),
        # 两个 response 的 payload 层写 None：RunTaskResponse.result 已经是
        # 强类型的判别联合，envelope 校验会递归到 facts 与 events。
        # host 那边需要单独钉 payload，是因为 HostExecuteToolResult 只有 ok 一个字段。
        (
            "agent-run-task.completed.response.json",
            RunTaskResponse,
            None,
            "result",
        ),
        (
            "agent-run-task.failed.response.json",
            RunTaskResponse,
            None,
            "result",
        ),
    ],
)
def test_legal_fixtures_are_accepted(name, envelope, payload, field):
    raw = _load(name)
    envelope.model_validate(raw)
    if payload is not None:
        payload.model_validate(_pick(raw, field))


def test_illegal_fixtures_are_not_accepted():
    invalid_dir = FIXTURES_DIR / "invalid"
    for path in sorted(invalid_dir.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        # host- 前缀必须先判：Envelope 的 Request 不校验 id 命名空间和
        # capability 白名单，用它校验这三个 fixture 会全部通过。
        if path.name.startswith("host-request-"):
            with pytest.raises(ValidationError):
                HostExecuteToolRequest.model_validate(raw)
        elif path.name.startswith("host-response-"):
            with pytest.raises(ValidationError):
                HostExecuteToolResponse.model_validate(raw)
        elif path.name.startswith("request-"):
            with pytest.raises(ValidationError):
                Request.model_validate(raw)
        elif path.name.startswith("response-"):
            with pytest.raises(ValidationError):
                Response.model_validate(raw)
        else:
            pytest.fail(f"未知前缀的非法 fixture: {path.name}")


def test_host_schemas_do_not_drift_from_envelope():
    """host 的 Request/Response 没继承 Envelope，用这两条钉住包含关系。

    TS 侧 envelope.test.ts 有对称的一组。两边任一放宽都会在这里红。
    """
    req = _load("host-execute-tool.request.json")
    HostExecuteToolRequest.model_validate(req)
    Request.model_validate(req)

    for name in (
        "host-execute-tool.response.json",
        "host-execute-tool.failure.response.json",
    ):
        resp = _load(name)
        HostExecuteToolResponse.model_validate(resp)
        Response.model_validate(resp)


# 与 packages/protocol/tests/envelope.test.ts 的「InitializeParams 的能力清单约束」
# 一一对应。两边判定不一致就是契约漂移。
def test_initialize_params_capabilities_constraints():
    legal = {
        "protocolVersion": "0.1",
        "capabilities": [
            {
                "name": "filesystem.list",
                "kind": "READ",
                "description": "列出授权根目录下的条目",
            }
        ],
        "client": {"name": "personal-agent-electron", "version": "0.1.0"},
    }
    InitializeParams.model_validate(legal)

    # 缺字段必须拒。给默认空数组的话，TS 侧漏传与“真的没有可见能力”
    # 在 wire 上无法分辨。
    without = {k: v for k, v in legal.items() if k != "capabilities"}
    with pytest.raises(ValidationError):
        InitializeParams.model_validate(without)

    # 单个对象而非数组：TS 侧漏写 z.array() 时会接受这个形状。
    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {**legal, "capabilities": legal["capabilities"][0]}
        )

    # 空数组合法：一个能力都不可见是合法配置，不是错误。
    InitializeParams.model_validate({**legal, "capabilities": []})

    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {
                **legal,
                "capabilities": [{**legal["capabilities"][0], "description": ""}],
            }
        )

    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {
                **legal,
                "capabilities": [
                    {**legal["capabilities"][0], "name": "filesystem.delete"}
                ],
            }
        )


# ---- agent.run_task ----
# 以下五个函数与 envelope.test.ts 的五个 describe 逐条对应。
# RunTaskResult 是 Annotated 别名而不是 model，要用 TypeAdapter 才能校。
TASK_EVENT = {
    "type": "tool_called",
    "payload": {"capability": "filesystem.list"},
    "occurredAt": "2026-09-11T10:00:00.120Z",
}

RUN_TASK_RESULT = TypeAdapter(RunTaskResult)


def test_run_task_params_constraints():
    RunTaskParams.model_validate({"taskId": "t-1", "goal": "整理 PDF"})

    with pytest.raises(ValidationError):
        RunTaskParams.model_validate({"taskId": "t-1", "goal": ""})

    with pytest.raises(ValidationError):
        RunTaskParams.model_validate({"goal": "整理 PDF"})

    # 多出预算字段就意味着 TS 能调预算，UI 就得暴露旋钮并校验范围，
    # 而指导书没这个需求。
    assert list(RunTaskParams.model_fields) == ["taskId", "goal"]


def test_run_task_event_constraints():
    # 带上 taskId 就允许 Python 把事件回传到别的任务上，而那个 id 恰好存在时
    # DB 外键不会拦，Timeline 会静默串任务。
    assert list(RunTaskEvent.model_fields) == ["type", "payload", "occurredAt"]

    RunTaskEvent.model_validate(TASK_EVENT)

    # Python 的 datetime.now(timezone.utc).isoformat() 默认就是 +00:00 结尾，
    # engine 不显式格式化会在这里红。
    for bad_occurred_at in (
        "2026-09-11T10:00:00.120+00:00",
        "2026-09-11T10:00:00Z",
        "2026-09-11T10:00:00.120000Z",
    ):
        with pytest.raises(ValidationError):
            RunTaskEvent.model_validate(
                {**TASK_EVENT, "occurredAt": bad_occurred_at}
            )

    with pytest.raises(ValidationError):
        RunTaskEvent.model_validate({**TASK_EVENT, "type": ""})

    # execution_events.payload 是 TEXT NOT NULL，落库走 JSON.stringify(event.payload)。
    # 契约允许缺键的话，undefined 会在 better-sqlite3 绑定处炸，或者 TS 侧
    # 补一个 ?? {} 的静默默认，把生产端漏字段盖住。
    with pytest.raises(ValidationError):
        RunTaskEvent.model_validate(
            {"type": "t", "occurredAt": TASK_EVENT["occurredAt"]}
        )

    # 显式 null 合法：JSON.stringify(null) 是 "null"，存得进 NOT NULL 列也读得回。
    RunTaskEvent.model_validate(
        {"type": "t", "payload": None, "occurredAt": TASK_EVENT["occurredAt"]}
    )


def test_summary_fact_constraints():
    assert list(SummaryFact.model_fields) == ["text", "pageRefs"]

    # REQ-007 的「必须有页码引用」是业务规则，判定它的是 TASK-014 的
    # SummaryVerifier。契约层拒的话错误码会指向 PROTOCOL 而不是
    # 「摘要不可信」，排查方向就错了。
    SummaryFact.model_validate({"text": "结论", "pageRefs": []})

    for bad_refs in ([0], [-1], [1.5]):
        with pytest.raises(ValidationError):
            SummaryFact.model_validate({"text": "结论", "pageRefs": bad_refs})

    with pytest.raises(ValidationError):
        SummaryFact.model_validate({"text": "", "pageRefs": [1]})


def test_run_task_result_discriminated_union():
    RUN_TASK_RESULT.validate_python(
        {"status": "completed", "facts": [], "events": []}
    )
    RUN_TASK_RESULT.validate_python(
        {"status": "failed", "reason": "预算耗尽", "events": []}
    )

    # tasks 表的 CHECK 允许五个值，但那是 TS 侧 ALLOWED_TRANSITIONS 管的。
    # Python 能回 running 就等于给了它改任务生命周期的权力。
    for bad_result in (
        {"status": "running", "events": []},
        {"status": "completed", "events": []},
        {"status": "failed", "events": []},
        {"status": "failed", "reason": "预算耗尽"},
    ):
        with pytest.raises(ValidationError):
            RUN_TASK_RESULT.validate_python(bad_result)


def test_run_task_envelope_constraints():
    with pytest.raises(ValidationError):
        RunTaskRequest.model_validate(
            {
                "jsonrpc": "2.0",
                "id": "req-002",
                "method": "agent.runTask",
                "params": {"taskId": "t-1", "goal": "g"},
            }
        )

    with pytest.raises(ValidationError):
        RunTaskResponse.model_validate(
            {
                "jsonrpc": "2.0",
                "id": "req-002",
                "result": {"status": "completed", "facts": [], "events": []},
                "error": {"code": "X", "message": "y"},
            }
        )

    with pytest.raises(ValidationError):
        RunTaskResponse.model_validate({"jsonrpc": "2.0", "id": "req-002"})


# ---- agent.make_plan ----
# 与 envelope.test.ts 的「MakePlan 的约束」逐条对应。两边判定不一致就是契约漂移。
SUMMARY_STEP_DESCRIPTION = "基于页面内容生成带页码引用的摘要"


def test_make_plan_constraints():
    assert list(MakePlanParams.model_fields) == ["taskId", "goal"]
    assert list(PlanStepDto.model_fields) == ["description", "capability"]

    # capability 缺失合法：摘要那一步不经工具。
    PlanStepDto.model_validate({"description": SUMMARY_STEP_DESCRIPTION})

    # 与 TS 的差别就在这一条：这边 None 是合法值，zod 那边 null 被拒。
    # 两端能对上，靠的是 Response.model_dump(exclude_none=True) 把 None 剔掉，
    # 下面一条钉的就是这个剔除行为。
    PlanStepDto.model_validate(
        {"description": SUMMARY_STEP_DESCRIPTION, "capability": None}
    )

    # 计划不能承诺不存在的能力，也不能承诺空描述。
    with pytest.raises(ValidationError):
        PlanStepDto.model_validate(
            {"description": "x", "capability": "filesystem.delete"}
        )
    with pytest.raises(ValidationError):
        PlanStepDto.model_validate({"description": ""})

    # 空计划会让 Main 侧的 ActionAlignment 没有比对基准。
    with pytest.raises(ValidationError):
        MakePlanResult.model_validate({"steps": []})

    with pytest.raises(ValidationError):
        MakePlanRequest.model_validate(
            {
                "jsonrpc": "2.0",
                "id": "req-001",
                "method": "agent.makePlan",
                "params": {"taskId": "t-1", "goal": "g"},
            }
        )

    with pytest.raises(ValidationError):
        MakePlanResponse.model_validate(
            {
                "jsonrpc": "2.0",
                "id": "req-001",
                "result": {"steps": [{"description": "x"}]},
                "error": {"code": "X", "message": "y"},
            }
        )

    with pytest.raises(ValidationError):
        MakePlanResponse.model_validate({"jsonrpc": "2.0", "id": "req-001"})


def test_make_plan_response_dumps_without_a_null_capability():
    """exclude_none 必须递归到 steps 里面，否则线上形状与 zod 的 optional 相反。

    直接用 Python 自己的模型重建一份回包，要求与共享 fixture 逐键相等：
    这一步同时钉住了 planning.py 的三步描述、exclude_none 的递归行为、
    以及 fixture 本身没被人手改过。
    """
    fixture = _load("agent-make-plan.response.json")
    MakePlanResponse.model_validate(fixture)
    assert fixture["result"]["steps"][2] == {
        "description": SUMMARY_STEP_DESCRIPTION
    }

    rebuilt = MakePlanResponse.model_validate(
        {
            "jsonrpc": "2.0",
            "id": "req-001",
            "result": MakePlanResult(
                steps=[
                    PlanStepDto(
                        description="列出 Downloads 下的 PDF",
                        capability="filesystem.list",
                    ),
                    PlanStepDto(
                        description="提取目标 PDF 的每页文本",
                        capability="document.extract_pdf",
                    ),
                    PlanStepDto(description=SUMMARY_STEP_DESCRIPTION),
                ]
            ).model_dump(exclude_none=True),
        }
    ).model_dump(exclude_none=True)
    assert rebuilt == fixture
