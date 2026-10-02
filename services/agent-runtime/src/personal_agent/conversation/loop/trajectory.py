"""services/agent-runtime/src/personal_agent/conversation/loop/trajectory.py

死亡螺旋防护、通用工具指纹死循环检测与轨迹完整性自动修复。
依据 meta_capability_design_spec.md §2.2 B、§2.2 D 与 §2.4 B。
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections import defaultdict, deque
from collections.abc import Generator, Sequence
from dataclasses import dataclass, field
from typing import Any

from personal_agent.conversation.model.gateway import (
    Observation,
    ToolCallDecision,
    ToolCallItem,
)

log = logging.getLogger(__name__)

MAX_RECOVERY_DEPTH: int = 2
DEFAULT_FINGERPRINT_WINDOW: int = 5
DEFAULT_CONSECUTIVE_DUPLICATE_LIMIT: int = 3


class DeathSpiralError(Exception):
    """死亡螺旋检测：错误恢复嵌套深度超过上限，强制终止任务。"""

    def __init__(self, depth: int, max_depth: int) -> None:
        super().__init__(
            f"死亡螺旋检测：错误恢复深度 {depth} 超过上限 {max_depth}，强制终止任务避免无限连锁故障"
        )
        self.depth = depth
        self.max_depth = max_depth


class DeathSpiralProtector:
    """死亡螺旋防护器（§2.4 B）。

    通过递归恢复深度计数器检测并打断残余的连锁故障（如错误恢复自身调 LLM 再出错）。
    """

    def __init__(self, max_depth: int = MAX_RECOVERY_DEPTH) -> None:
        self._max_depth = max_depth
        self._depth = 0

    @property
    def depth(self) -> int:
        return self._depth

    @property
    def max_depth(self) -> int:
        return self._max_depth

    def enter(self) -> bool:
        """进入错误恢复路径。返回 False 表示已超过最大允许深度，必须终止。"""
        self._depth += 1
        if self._depth > self._max_depth:
            log.error(
                "死亡螺旋检测：恢复深度 %d 超过上限 %d，强制终止",
                self._depth,
                self._max_depth,
            )
            return False
        return True

    def exit(self) -> None:
        """退出错误恢复路径。安全递减深度，下界为 0。"""
        self._depth = max(0, self._depth - 1)

    def reset(self) -> None:
        """重置深度计数。"""
        self._depth = 0

    @contextlib.contextmanager
    def guard(self) -> Generator[None]:
        """上下文管理器：自动进入和退出恢复路径，超限时抛出 DeathSpiralError。"""
        exceeded = not self.enter()
        try:
            if exceeded:
                raise DeathSpiralError(self._depth, self._max_depth)
            yield
        finally:
            self.exit()


def compute_tool_fingerprint(capability: str, arguments: dict[str, Any] | None) -> str:
    """计算工具调用的规范化指纹。

    对参数做键排序与紧凑 JSON 序列化，确保语义相同的字典产生确定性相同的指纹。
    """
    args = arguments or {}
    try:
        canonical_args = json.dumps(
            args, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
    except (TypeError, ValueError):
        canonical_args = str(sorted(args.items()))
    return f"{capability}:{canonical_args}"


class ToolFingerprintDetector:
    """通用工具调用指纹与死循环探测器（§2.2 B）。

    记录近期工具调用指纹，发现连续发起相同参数的工具调用时拦截并报警。
    """

    def __init__(
        self,
        consecutive_limit: int = DEFAULT_CONSECUTIVE_DUPLICATE_LIMIT,
        window_size: int = DEFAULT_FINGERPRINT_WINDOW,
    ) -> None:
        self._consecutive_limit = consecutive_limit
        self._window_size = window_size
        self._history: deque[str] = deque(maxlen=window_size)

    def check_and_record(
        self, capability: str, arguments: dict[str, Any] | None
    ) -> tuple[bool, str | None]:
        """检查当前工具调用是否与近期调用重复停滞，并记录当前指纹。

        返回 (is_duplicate_loop, warning_message)。
        """
        fingerprint = compute_tool_fingerprint(capability, arguments)

        # 检查是否达到连续相同调用阈值
        consecutive_count = 0
        for prev in reversed(self._history):
            if prev == fingerprint:
                consecutive_count += 1
            else:
                break

        self._history.append(fingerprint)

        if consecutive_count >= (self._consecutive_limit - 1):
            msg = (
                f"【系统警告】检测到连续多次发起完全相同的工具调用（'{capability}'），"
                "操作已陷入停滞。请勿重复使用相同参数，建议更换参数、尝试替代工具或推进作答。"
            )
            return True, msg

        return False, None

    def reset(self) -> None:
        """清空调用指纹历史。"""
        self._history.clear()


@dataclass(frozen=True)
class TrajectoryRepairReport:
    """轨迹修复报告。记录轨迹完整性检查中修补的结果。"""

    repaired_observations: list[Observation]
    repaired_call_ids: list[str] = field(default_factory=list)

    @property
    def has_repaired(self) -> bool:
        return len(self.repaired_call_ids) > 0


def repair_trajectory_integrity(
    tool_calls: Sequence[ToolCallItem | ToolCallDecision],
    observations: Sequence[Observation],
) -> TrajectoryRepairReport:
    """检查并自动修复工具调用与观察结果的配对完整性（§2.2 D）。
    规则：
    1. 遍历 tool_calls，依次通过 callId 从历史 observations 的 FIFO 队列中匹配；
    2. 若某个 callId 在 observations 中缺失，生成合成错误 Observation 进行占位修补；
    3. 未被 tool_calls 配对消耗的多余/孤立 Observation 依然保留并追加在末尾（保持原序），绝不丢弃。
    """
    if not tool_calls:
        return TrajectoryRepairReport(
            repaired_observations=list(observations),
            repaired_call_ids=[],
        )
    obs_queue: dict[str, deque[Observation]] = defaultdict(deque)
    for obs in observations:
        obs_queue[obs.callId].append(obs)
    repaired_obs: list[Observation] = []
    repaired_call_ids: list[str] = []

    for call in tool_calls:
        call_id = call.callId
        if obs_queue[call_id]:
            matched_obs = obs_queue[call_id].popleft()
            repaired_obs.append(matched_obs)
        else:
            synth_obs = Observation(
                callId=call_id,
                capability=call.capability,
                ok=False,
                payload={
                    "error": "broken_trajectory",
                    "reason": "工具调用未收到对应结果响应，已由系统自动修复配对关系",
                },
                arguments=call.arguments or {},
            )
            repaired_obs.append(synth_obs)
            repaired_call_ids.append(call_id)

    # 将未被匹配的孤立/剩余观测追加到末尾，保持其在原始 observations 中的相对顺序
    for obs in observations:
        queue = obs_queue[obs.callId]
        if queue and queue[0] is obs:
            repaired_obs.append(queue.popleft())
    return TrajectoryRepairReport(
        repaired_observations=repaired_obs,
        repaired_call_ids=repaired_call_ids,
    )
