"""ReAct 调度读写分流并发与批内容错模块 (Task 2.1)"""

import concurrent.futures
import logging
from collections.abc import Callable, Sequence
from typing import Literal

from personal_agent.conversation.model.gateway import Observation, ToolCallItem
from personal_agent.protocol.models import CapabilityDescriptor, CapabilityKind

log = logging.getLogger("personal_agent")

# 动态能力读写属性注册表（由握手或测试动态装载，无硬编码）
_CAPABILITY_REGISTRY: dict[str, CapabilityKind] = {}


def register_capabilities(descriptors: Sequence[CapabilityDescriptor]) -> None:
    """根据宿主握手下发的描述符动态注册能力的读写属性（单一事实来源）。"""
    for d in descriptors:
        _CAPABILITY_REGISTRY[d.name] = d.kind


def clear_registered_capabilities() -> None:
    """清理已注册能力，供测试隔离使用。"""
    _CAPABILITY_REGISTRY.clear()


def is_read_capability(
    capability: str,
    descriptors: Sequence[CapabilityDescriptor] | None = None,
) -> bool:
    """动态判定指定 capability 是否为只读、无副作用且天然幂等的能力。

    规则：
    1. 优先从显式传入的 descriptors 中查匹配项；
    2. 其次从动态注册表 _CAPABILITY_REGISTRY 中查询；
    3. 若未查到，执行 fail-closed 原则，一律返回 False（视为 WRITE 串行处理）。
    """
    if descriptors is not None:
        for d in descriptors:
            if d.name == capability:
                return d.kind == "READ"
    return _CAPABILITY_REGISTRY.get(capability) == "READ"


def partition_tool_calls(
    calls: Sequence[ToolCallItem],
    is_read_fn: Callable[[str], bool] | None = None,
) -> list[tuple[Literal["parallel", "serial"], list[ToolCallItem]]]:
    """将单批 tool_calls 切分为交替的并行 READ 组和串行 WRITE 组。

    # Contract:
    #   - Input: calls 列表, 可选 is_read_fn 判定函数
    #   - Output: [("parallel" | "serial", [ToolCallItem])]
    #   - Invariants: 连续的 READ 聚合成一个 ("parallel", [...])；每一个 WRITE 独立作为一个 ("serial", [call])
    #   - Test file: tests/test_react_loop_concurrency.py::test_partition_tool_calls_*
    """
    check_read = is_read_fn or is_read_capability
    partitions: list[tuple[Literal["parallel", "serial"], list[ToolCallItem]]] = []
    current_reads: list[ToolCallItem] = []
    for call in calls:
        if check_read(call.capability):
            current_reads.append(call)
        else:
            if current_reads:
                partitions.append(("parallel", current_reads))
                current_reads = []
            partitions.append(("serial", [call]))
    if current_reads:
        partitions.append(("parallel", current_reads))
    return partitions


def execute_tool_calls_batched(
    calls: Sequence[ToolCallItem],
    execute_single_fn: Callable[[ToolCallItem], Observation],
    max_workers: int = 4,
    is_read_fn: Callable[[str], bool] | None = None,
) -> list[Observation]:
    """批量执行工具调用，实现读写分流调度与批内独立容错。

    # Contract:
    #   - Input: calls 序列, 单工具执行函数 execute_single_fn, 并发线程数 max_workers
    #   - Output: 与 calls 严格一一对应且保序的 Observation 列表
    #   - Fault Isolation: 任何单个工具抛出异常或失败，必须包装成 ok=False 的 Observation，绝不上浮中断同批调用
    #   - Test file: tests/test_react_loop_concurrency.py::test_execute_batch_*
    """
    partitions = partition_tool_calls(calls, is_read_fn=is_read_fn)
    results_map: dict[str, Observation] = {}

    def _safe_exec(item: ToolCallItem) -> Observation:
        try:
            return execute_single_fn(item)
        except Exception as e:  # noqa: BLE001
            log.warning("工具调用 %s 执行异常已隔离: %s", item.callId, e)
            return Observation(
                callId=item.callId,
                capability=item.capability,
                ok=False,
                payload={"error": str(e)},
                arguments=item.arguments,
            )


    for (mode,part_calls) in partitions:
        if mode == "parallel":
            if len(part_calls) == 1:
                obs = _safe_exec(part_calls[0])
                results_map[obs.callId] = obs
            elif len(part_calls) > 1:
                with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(part_calls), max_workers)) as executor:
                    future_to_call = {executor.submit(_safe_exec, call): call for call in part_calls}
                    for future in concurrent.futures.as_completed(future_to_call):
                        obs = future.result()
                        results_map[obs.callId] = obs
        elif mode == "serial":
            for call in part_calls:
                obs = _safe_exec(call)
                results_map[obs.callId] = obs
    return [results_map[c.callId] for c in calls if c.callId in results_map]