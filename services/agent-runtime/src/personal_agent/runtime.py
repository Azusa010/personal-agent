import json
import logging
import os
import sys
from dataclasses import dataclass, field

from pydantic import ValidationError

from personal_agent.host_channel import HostChannel
from personal_agent.model_gateway import ModelGateway
from personal_agent.protocol.models import (
    AGENT_RUN_TASK,
    CapabilityDescriptor,
    InitializeParams,
    InitializeResult,
    Request,
    Response,
    ServerInfo,
)

SERVER_INFO = ServerInfo(name="personal-agent-runtime", version="0.1.0")

# Phase 1 全程用 ScriptedModel（CON-006 + PAT-004），真实模型 adapter 还不存在。
# 所以 main() 起的进程握手与 ping 都正常，收到 agent.run_task 时回这个码，
# 而不是拿一个空脚本的 ScriptedModel 去跑然后立即耗尽。
RUNTIME_MODEL_NOT_CONFIGURED = "RUNTIME_MODEL_NOT_CONFIGURED"


@dataclass
class RuntimeDeps:
    """一个进程一份。channel 与 model 是造 engine 的原料，capabilities 是会话状态。

    engine 与 ContextManager 不放这儿：ContextManager 持有 observations，
    跨任务复用会把上一个任务的观察串进来，所以每次 run_task 现场构造。
    """

    channel: HostChannel
    model: ModelGateway | None = None
    capabilities: list[CapabilityDescriptor] = field(default_factory=list)


def build_error(req_id, code: str, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def dispatch(raw, deps: RuntimeDeps | None = None) -> dict:
    """输入已解析的 dict，输出响应 dict。"""
    try:
        req = Request.model_validate(raw)
    except ValidationError:
        req_id = raw.get("id") if isinstance(raw, dict) else None
        return build_error(req_id, "PROTOCOL_INVALID_REQUEST", "请求不符合契约")

    if req.method == "system.ping":
        return Response(jsonrpc="2.0", id=req.id, result={}).model_dump(
            exclude_none=True
        )

    if req.method == "system.initialize":
        return handle_initialize(req, deps)

    if req.method == AGENT_RUN_TASK:
        return handle_run_task(req, deps)

    return build_error(
        req_id=req.id, code="METHOD_NOT_FOUND", message=f"未知方法:{req.method}"
    )


def handle_line(line: str, deps: RuntimeDeps | None = None):
    """一行文本 → 响应 dict；空行返回 None"""
    line = line.strip()
    if not line:
        return None
    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        log.warning("无法解析 JSON: %.200s", line)
        return build_error(None, "PROTOCOL_INVALID_JSON", "无法解析 JSON")
    return dispatch(raw, deps)


def handle_initialize(req: Request, deps: RuntimeDeps | None = None) -> dict:
    try:
        params = InitializeParams.model_validate(req.params)
    except ValidationError:
        return build_error(
            req.id,
            "PROTOCOL_INVALID_REQUEST",
            "initialize 参数不符合契约(或协议版本不匹配)",
        )
    if deps is not None:
        # Exit Checklist 第 3 条的链路从这里开始：TS 按 Scope 过滤后下发，
        # 存住，run_task 时取 name 进 ModelContext.visibleCapabilities。
        deps.capabilities = list(params.capabilities)
    result = InitializeResult(protocolVersion="0.1", server=SERVER_INFO)
    return Response(jsonrpc="2.0", id=req.id, result=result.model_dump()).model_dump(
        exclude_none=True
    )


def handle_run_task(req: Request, deps: RuntimeDeps | None = None) -> dict:
    raise NotImplementedError(
        """
TODO: 跑一个任务，把 engine 的结果包成 RunTaskResponse 的 dict。

要做什么
  - RunTaskParams.model_validate(req.params) 拿 taskId 与 goal，
    不过就 build_error(req.id, "PROTOCOL_INVALID_REQUEST", …)
  - deps 为 None 或 deps.model 为 None：
    build_error(req.id, RUNTIME_MODEL_NOT_CONFIGURED, …)
  - 现场造 ContextManager 与 AgentEngine（model 与 channel 从 deps 取）
  - visibleCapabilities 是 [c.name for c in deps.capabilities]
  - engine.run(goal, visibleCapabilities) 拿 RunTaskCompleted | RunTaskFailed
  - 用 Response(jsonrpc="2.0", id=req.id, result=outcome.model_dump())
    再 .model_dump(exclude_none=True) 返回，跟 handle_initialize 一个形状

必须处理的边界
  - engine.run 只接它自己列的那几种异常，其余的会冒到这儿。
    要有一个兜底把它们转成 build_error(req.id, "RUNTIME_INTERNAL", …) 并
    log.exception 到 stderr。不兜的话 Python traceback 上 stdout 是空的，
    TS 侧只能等满 30 秒超时（GUD-003：stdout 只承载协议消息）
  - 参数校验要在 deps 检查之前：调用方传错了参数和运行时没配模型
    是两件事，错误码得能分开
  - outcome 已经是 RunTaskCompleted / RunTaskFailed，不要重新拼 dict，
    也不要在这儿改 status —— Python 不许回 running，那是 TS 侧
    ALLOWED_TRANSITIONS 的权力（SEC-003）
  - taskId 这一片用不上：engine 不发 taskId，RunTaskEvent 里也没有这个字段
    （3b 钉死的），TS 侧自己知道这个响应属于哪个任务。不要把它塞进 payload

不该做什么
  - 不要在这里落库。持久化在 TS 侧，Python 只回传 events
  - 不要 catch 住异常再返回一个 status="completed" 的空结果
  - 不要复用上一个任务的 ContextManager

验收：tests/test_runtime.py 的 test_run_task_*
"""
    )


# ====== I/O 层 ========
def write(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _setup_logging() -> logging.Logger:
    logger = logging.getLogger("personal_agent")
    logger.setLevel(os.environ.get("PERSONAL_AGENT_LOG_LEVEL", "INFO").upper())
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(handler)
    logger.propagate = False
    return logger


log = _setup_logging()


def run(channel: HostChannel | None = None) -> None:
    ch = (
        channel
        if channel is not None
        else HostChannel(readline=sys.stdin.readline, write_msg=write)
    )
    deps = RuntimeDeps(channel=ch)
    log.info("runtime started")
    while True:
        line = ch.next_line()
        # readline() 在 EOF 时返回空字符串，不是 None。判 is None 的话这个
        # break 永远不触发：stdin 关闭后 next_line() 一直返回 ''，
        # handle_line('') 返回 None 不写任何东西，进程 100% CPU 忙等死循环。
        if not line:
            break
        resp = handle_line(line, deps)
        if resp is not None:
            write(resp)
    log.info("runtime stopped (stdin EOF)")
