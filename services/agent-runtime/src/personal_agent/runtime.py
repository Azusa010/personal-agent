import json
import logging
import os
import sys

from pydantic import ValidationError

from personal_agent.protocol.models import (
    InitializeParams,
    InitializeResult,
    Request,
    Response,
    ServerInfo,
)

SERVER_INFO = ServerInfo(name="personal-agent-runtime", version="0.1.0")


def build_error(req_id, code: str, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def dispatch(raw) -> dict:
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
        return handle_initialize(req)

    return build_error(
        req_id=req.id, code="METHOD_NOT_FOUND", message=f"未知方法:{req.method}"
    )


def handle_line(line: str):
    """一行文本 → 响应 dict；空行返回 None"""
    line = line.strip()
    if not line:
        return None
    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        log.warning("无法解析 JSON: %.200s", line)
        return build_error(None, "PROTOCOL_INVALID_JSON", "无法解析 JSON")
    return dispatch(raw)


def handle_initialize(req: Request) -> dict:
    try:
        InitializeParams.model_validate(req.params)
    except ValidationError:
        return build_error(
            req.id,
            "PROTOCOL_INVALID_REQUEST",
            "initialize 参数不符合契约(或协议版本不匹配)",
        )
    result = InitializeResult(protocolVersion="0.1", server=SERVER_INFO)
    return Response(jsonrpc="2.0", id=req.id, result=result.model_dump()).model_dump(
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


def run() -> None:
    log.info("runtime started")
    for line in sys.stdin:
        resp = handle_line(line)
        if resp is not None:
            write(resp)
    log.info("runtime stopped (stdin EOF)")
