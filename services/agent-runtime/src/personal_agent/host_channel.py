import json
import logging
from collections import deque
from collections.abc import Callable

from pydantic import ValidationError

from personal_agent.protocol.models import (
    HOST_EXECUTE_TOOL,
    HostExecuteToolParams,
    HostExecuteToolRequest,
    HostExecuteToolResponse,
)

log = logging.getLogger("personal_agent")


class HostChannelClosed(Exception):
    """stdin EOF：TS 侧进程已退出或关闭了管道。"""


class HostRequestFailed(Exception):
    """
    TS 回了 error，或响应本身不合契约。

    capability 的业务失败（PDF 损坏、加密）不走这里
    ok:false，要原样交给 engine 写进 timeline。这里只表示系统级故障。
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"host 请求失败 [{code}]: {message}")
        self.code = code
        self.message = message


class HostChannel:
    def __init__(
        self, readline: Callable[[], str], write_msg: Callable[[dict], None]
    ) -> None:
        self._readline = readline
        self._write_msg = write_msg
        self._counter = 0
        self.inbox: deque[str] = deque()

    def call_host(self, params: HostExecuteToolParams):
        self._counter += 1
        rpc_id = f"call-{self._counter}"
        self._write_msg(
            HostExecuteToolRequest(
                jsonrpc="2.0",
                id=rpc_id,
                method=HOST_EXECUTE_TOOL,
                params=params,
            ).model_dump()
        )

        while True:
            line = self._readline()
            if not line:
                raise HostChannelClosed(
                    f"等 {rpc_id} 的响应时 stdin 关闭，TS 侧进程可能已退出"
                )
            text = line.strip()
            if not text:
                continue
            try:
                raw = json.loads(text)
            except json.JSONDecodeError:
                log.warning("等 host 响应时读到非法 JSON，丢弃: %.200s", text)
                continue
            if raw.get("id") != rpc_id or "method" in raw:
                self.inbox.append(text)
                continue
            try:
                resp = HostExecuteToolResponse.model_validate(raw)
            except ValidationError as e:
                raise HostRequestFailed("PROTOCOL_INVALID_RESPONSE", str(e)) from e
            if resp.error is not None:
                raise HostRequestFailed(resp.error.code, resp.error.message)
            if resp.result is None:
                raise HostRequestFailed(
                    "PROTOCOL_INVALID_RESPONSE",
                    f"{rpc_id} 的响应既无 result 也无 error",
                )
            return resp.result

    def next_line(self):
        if self.inbox:
            return self.inbox.popleft()
        return self._readline()
