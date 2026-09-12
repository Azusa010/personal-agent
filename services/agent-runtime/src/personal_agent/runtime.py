import json
import logging
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field

from pydantic import ValidationError

from personal_agent.context import ContextManager
from personal_agent.engine import AgentEngine
from personal_agent.host_channel import HostChannel
from personal_agent.model_gateway import ModelGateway
from personal_agent.protocol.models import (
    AGENT_RUN_TASK,
    CapabilityDescriptor,
    InitializeParams,
    InitializeResult,
    Request,
    Response,
    RunTaskParams,
    ServerInfo,
)
from personal_agent.scripted_model import ScriptedModel, ScriptLoadError, load_script

SERVER_INFO = ServerInfo(name="personal-agent-runtime", version="0.1.0")

# Phase 1 全程用 ScriptedModel（CON-006 + PAT-004），真实模型 adapter 还不存在。
# 所以 main() 起的进程握手与 ping 都正常，收到 agent.run_task 时回这个码，
# 而不是拿一个空脚本的 ScriptedModel 去跑然后立即耗尽。
RUNTIME_MODEL_NOT_CONFIGURED = "RUNTIME_MODEL_NOT_CONFIGURED"

# 剧本路径从这个环境变量读。与 DEP-012 的 OPENAI_MODEL 同构：
# 默认不配，要用就显式开启。
SCRIPT_ENV = "PERSONAL_AGENT_SCRIPT"


@dataclass
class RuntimeDeps:
    """一个进程一份。channel 与 model_factory 是造 engine 的原料，capabilities 是会话状态。

    engine 与 ContextManager 不放这儿：ContextManager 持有 observations，
    跨任务复用会把上一个任务的观察串进来，所以每次 run_task 现场构造。

    存工厂而不是存 model 实例，是同一条理由：ScriptedModel 持有 _cursor，
    一个实例跑第二个任务时剧本已经用完了。REQ-010 要求连跑 20 次。
    """

    channel: HostChannel
    model_factory: Callable[[], ModelGateway] | None = None
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
    try:
        params = RunTaskParams.model_validate(req.params)
    except ValidationError:
        return build_error(
            req.id, "PROTOCOL_INVALID_REQUEST", "run_task 参数不符合契约"
        )

    if deps is None or deps.model_factory is None:
        return build_error(
            req.id, RUNTIME_MODEL_NOT_CONFIGURED, "运行时未配置模型，无法执行任务"
        )

    context = ContextManager()
    engine = AgentEngine(
        model=deps.model_factory(), channel=deps.channel, context=context
    )
    visible_capabilities = [c.name for c in deps.capabilities]
    try:
        outcome = engine.run(params.goal, visible_capabilities)
    except Exception:
        log.exception("agent.run_task 未预期异常 (id=%s)", req.id)
        return build_error(req.id, "RUNTIME_INTERNAL", "运行时内部错误")

    return Response(jsonrpc="2.0", id=req.id, result=outcome.model_dump()).model_dump(
        exclude_none=True
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


def resolve_model_factory() -> Callable[[], ModelGateway] | None:
    """
    按环境变量决定这个进程用哪个 ModelGateway，工厂每次调用都造一个新实例。
    """
    script_path = os.environ.get(SCRIPT_ENV)
    if not script_path:
        return None

    try:
        decisions = load_script(script_path)
    except ScriptLoadError as e:
        log.warning("剧本不可用，本进程不配模型: %s", e)
        return None

    def factory() -> ModelGateway:
        return ScriptedModel(decisions)

    return factory


def run(channel: HostChannel | None = None) -> None:
    ch = (
        channel
        if channel is not None
        else HostChannel(readline=sys.stdin.readline, write_msg=write)
    )
    deps = RuntimeDeps(channel=ch, model_factory=resolve_model_factory())
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
