"""流式审查门控屏障 (Stream Barrier)

支持与主模型流式输出并发执行安全审查，
并在物理工具执行下发前充当同步门控拦截屏障。
"""

import logging
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

from personal_agent.conversation.sidecar.classifier import (
    JevSafetyClassifier,
    classify_heuristic,
)
from personal_agent.protocol.models import SidecarAssessment

log = logging.getLogger("personal_agent.sidecar")


class StreamBarrier:
    """并发流式审查与同步门控屏障。"""

    def __init__(
        self,
        classifier: JevSafetyClassifier | None = None,
        max_workers: int = 2,
    ) -> None:
        self._classifier = classifier or JevSafetyClassifier()
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="sidecar-barrier",
        )
        self._futures: dict[str, Future[SidecarAssessment]] = {}

    def submit(
        self,
        call_id: str,
        capability: str,
        arguments: dict[str, Any],
        goal: str = "",
    ) -> None:
        """异步并发提交审查任务（在主模型输出工具调用意图时立即触发）。"""
        if call_id in self._futures:
            return

        future = self._executor.submit(
            self._classifier.classify,
            call_id,
            capability,
            arguments,
            goal,
        )
        self._futures[call_id] = future

    def wait_or_pass(
        self,
        call_id: str,
        capability: str,
        arguments: dict[str, Any],
        goal: str = "",
        timeout: float = 3.0,
    ) -> SidecarAssessment:
        """同步门控检查。若已在后台审查则取回结果，超时或异常则安全降级。"""
        future = self._futures.pop(call_id, None)

        if future is not None:
            try:
                return future.result(timeout=timeout)
            except Exception as err:  # noqa: BLE001
                log.warning("StreamBarrier 等待审查结果超时或异常，执行本地降级: %s", err)
                return classify_heuristic(call_id, capability, arguments)

        # 未提前提交，就地执行分类
        return self._classifier.classify(call_id, capability, arguments, goal)

    def close(self) -> None:
        """释放底层线程池资源。"""
        self._executor.shutdown(wait=False)
