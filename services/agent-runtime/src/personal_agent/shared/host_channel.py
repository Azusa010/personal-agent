import json
import logging
import queue
import threading
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
        self._request_handler: Callable[[dict], dict | None] | None = None

        # 消息队列与多线程并发分发机制
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._read_lock = threading.Lock()
        # 每个并发调用方拥有专属的消息队列
        self._pending_queues: dict[str, queue.Queue[dict | Exception]] = {}
        self._unclaimed: dict[str, dict] = {}
        self._closed = False

    def set_request_handler(
        self, handler: Callable[[dict], dict | None]
    ) -> None:
        self._request_handler = handler

    def _parse_response(self, rpc_id: str, raw: dict):
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

    def call_host(self, params: HostExecuteToolParams):
        with self._lock:
            self._counter += 1
            rpc_id = f"call-{self._counter}"
            # 检查是否有提前到达暂存的回包
            if rpc_id in self._unclaimed:
                raw = self._unclaimed.pop(rpc_id)
                return self._parse_response(rpc_id, raw)
            q: queue.Queue[dict | Exception] = queue.Queue()
            self._pending_queues[rpc_id] = q

        try:
            with self._write_lock:
                self._write_msg(
                    HostExecuteToolRequest(
                        jsonrpc="2.0",
                        id=rpc_id,
                        method=HOST_EXECUTE_TOOL,
                        params=params,
                    ).model_dump()
                )

            item: dict | Exception | None = None
            while True:
                # 1. 优先检查自身专属消息队列是否已收到分发来的回包
                try:
                    item = q.get_nowait()
                    break
                except queue.Empty:
                    pass

                with self._lock:
                    if self._closed:
                        raise HostChannelClosed(
                            f"等 {rpc_id} 的响应时 stdin 关闭，TS 侧进程可能已退出"
                        )

                # 2. 尝试获取读取权从底层的 readline 推进数据
                if self._read_lock.acquire(blocking=False):
                    try:
                        # 双重检查
                        try:
                            item = q.get_nowait()
                            break
                        except queue.Empty:
                            pass

                        # 严格只读底层管道，绝不读 inbox（inbox 只供主循环 next_line 消费）
                        line = self._readline()
                        if not line:
                            with self._lock:
                                self._closed = True
                                err = HostChannelClosed(
                                    f"等 {rpc_id} 的响应时 stdin 关闭，TS 侧进程可能已退出"
                                )
                                for target_q in self._pending_queues.values():
                                    target_q.put(err)
                            raise err

                        text = line.strip()
                        if not text:
                            continue

                        try:
                            msg = json.loads(text)
                        except json.JSONDecodeError:
                            log.warning("等 host 响应时读到非法 JSON，丢弃: %.200s", text)
                            continue

                        # 宿主主动请求（带 method）：由 handler 处理或暂存进 inbox
                        if "method" in msg:
                            if self._request_handler is not None:
                                resp = self._request_handler(msg)
                                if resp is not None:
                                    with self._write_lock:
                                        self._write_msg(resp)
                                continue
                            with self._lock:
                                self.inbox.append(text)
                            continue

                        # RPC 回包（带 id）：精准投递进目标队列
                        msg_id = str(msg.get("id") or "")
                        with self._lock:
                            target_q = self._pending_queues.get(msg_id)
                            if target_q is not None:
                                target_q.put(msg)
                            else:
                                self._unclaimed[msg_id] = msg
                    finally:
                        self._read_lock.release()
                else:
                    # 其他线程正在读底层管道，当前线程在自身队列上等待回包
                    try:
                        item = q.get(timeout=0.05)
                        break
                    except queue.Empty:
                        continue

        finally:
            with self._lock:
                self._pending_queues.pop(rpc_id, None)

        if isinstance(item, Exception):
            raise item
        if item is None:
            raise HostChannelClosed(
                f"等 {rpc_id} 的响应时异常终止，未接收到任何结果"
            )
        return self._parse_response(rpc_id, item)

    def next_line(self):
        with self._lock:
            if self.inbox:
                return self.inbox.popleft()
        return self._readline()
