"""ReActLoop 读写分流并发调度与批内容错测试 (Phase 2 Task 2.1)

本测试套件验证：
1. 动态能力读写判定 (is_read_capability): 拒绝硬编码，基于 CapabilityDescriptor 动态反射并 fail-closed 兜底
2. 读写分流切分算法 (partition_tool_calls): 连续 READ 聚合成 parallel 块，每个 WRITE 作为独立 serial 块
3. 批内独立容错 (Fault Boundary Isolation): 单个工具异常/失败绝不上浮中断同批其余工具，以 ok=False 结构化回灌
4. 批次工具在 ReAct 循环中的完整闭环：预算统计、事件派发与结果收集
"""

import threading
import time
from typing import Any

from personal_agent.context import ContextManager
from personal_agent.conversation.loop.concurrency import (
    clear_registered_capabilities,
    execute_tool_calls_batched,
    is_read_capability,
    partition_tool_calls,
    register_capabilities,
)
from personal_agent.conversation.loop.react_loop import ReActLoop, ReActOutcome
from personal_agent.engine import Budget
from personal_agent.model_gateway import (
    BatchToolCallDecision,
    Observation,
    SummaryDecision,
    ToolCallItem,
)
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolParams,
    HostExecuteToolResult,
)
from personal_agent.scripted_model import ScriptedModel

SAMPLE_DESCRIPTORS = [
    CapabilityDescriptor(name="file_read", kind="READ", description="read file"),
    CapabilityDescriptor(name="file_search", kind="READ", description="search file"),
    CapabilityDescriptor(name="read_document", kind="READ", description="read doc"),
    CapabilityDescriptor(name="file_write", kind="WRITE", description="write file"),
    CapabilityDescriptor(name="file_edit", kind="WRITE", description="edit file"),
    CapabilityDescriptor(name="terminal_execute", kind="WRITE", description="terminal"),
]


class ConcurrentFakeChannel:
    """支持多线程并发调用的 FakeChannel 模拟器。"""

    def __init__(
        self, result_map: dict[str, Any], delay_map: dict[str, float] | None = None
    ) -> None:
        self._result_map = result_map
        self._delay_map = delay_map or {}
        self.calls: list[HostExecuteToolParams] = []
        self._lock = threading.Lock()

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        with self._lock:
            self.calls.append(params)

        delay = self._delay_map.get(params.callId, 0.0)
        if delay > 0:
            time.sleep(delay)

        item = self._result_map.get(params.callId)
        if item is None:
            item = self._result_map.get(params.capability)
        if item is None:
            raise AssertionError(
                f"ConcurrentFakeChannel 未配置预设结果: {params.callId} / {params.capability}"
            )

        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


def test_dynamic_is_read_capability_and_fail_closed():
    """验证能力读写属性基于描述符动态判定，且对未知/未声明能力严格 fail-closed（判为 WRITE）。"""
    clear_registered_capabilities()

    # 1. 显式传入描述符列表进行动态判定
    assert is_read_capability("file_read", descriptors=SAMPLE_DESCRIPTORS) is True
    assert is_read_capability("file_write", descriptors=SAMPLE_DESCRIPTORS) is False

    # 2. 动态注册后无需显式传参
    register_capabilities(SAMPLE_DESCRIPTORS)
    assert is_read_capability("file_search") is True
    assert is_read_capability("file_edit") is False

    # 3. 契约底线断言：未知能力（如未初始化的能力或外部注入工具）一律 fail-closed 返回 False（按串行写入安全防护）
    assert is_read_capability("unknown_new_tool") is False


def test_partition_tool_calls_pure_reads():
    """场景：全为 READ 类能力，应整批合并为单个 parallel 分区。"""
    register_capabilities(SAMPLE_DESCRIPTORS)
    calls = [
        ToolCallItem(callId="c1", capability="file_read", arguments={"path": "a.py"}),
        ToolCallItem(callId="c2", capability="file_search", arguments={"pattern": "*.ts"}),
        ToolCallItem(callId="c3", capability="read_document", arguments={"path": "doc.pdf"}),
    ]

    partitions = partition_tool_calls(calls)

    # 契约断言：part_calls 包含全部三个调用
    assert len(partitions) == 1
    mode, part_calls = partitions[0]
    assert mode == "parallel"
    assert [c.callId for c in part_calls] == ["c1", "c2", "c3"]


def test_partition_tool_calls_mixed_reads_and_writes():
    """场景：读写交错 [Read, Read, Write, Read, Write]，必须拆分为对应模式的独立块。"""
    register_capabilities(SAMPLE_DESCRIPTORS)
    calls = [
        ToolCallItem(callId="c1", capability="file_read", arguments={"path": "a.py"}),
        ToolCallItem(callId="c2", capability="file_search", arguments={"pattern": "*.ts"}),
        ToolCallItem(callId="c3", capability="file_write", arguments={"path": "b.py", "content": "x"}),
        ToolCallItem(callId="c4", capability="file_read", arguments={"path": "c.py"}),
        ToolCallItem(callId="c5", capability="terminal_execute", arguments={"command": "ls"}),
    ]

    partitions = partition_tool_calls(calls)

    # 契约断言：5 个调用必须拆为 4 个批次（2 读并行，1 写串行，1 读并行，1 写串行）
    assert len(partitions) == 4
    modes = [p[0] for p in partitions]
    assert modes == ["parallel", "serial", "parallel", "serial"]
    assert [c.callId for c in partitions[0][1]] == ["c1", "c2"]
    assert [c.callId for c in partitions[1][1]] == ["c3"]
    assert [c.callId for c in partitions[2][1]] == ["c4"]
    assert [c.callId for c in partitions[3][1]] == ["c5"]


def test_execute_batch_concurrent_reads_timing():
    """场景：两个分别耗时 0.05s 的只读调用，并发执行总耗时应显著小于串行耗时（< 0.08s）。"""
    register_capabilities(SAMPLE_DESCRIPTORS)
    calls = [
        ToolCallItem(callId="c1", capability="file_read", arguments={"path": "1.py"}),
        ToolCallItem(callId="c2", capability="file_read", arguments={"path": "2.py"}),
    ]

    results = {
        "c1": {"ok": True, "content": "1", "totalLines": 1},
        "c2": {"ok": True, "content": "2", "totalLines": 1},
    }
    delays = {"c1": 0.05, "c2": 0.05}
    channel = ConcurrentFakeChannel(results, delay_map=delays)

    def _exec(item: ToolCallItem) -> Observation:
        params = HostExecuteToolParams(
            callId=item.callId, capability=item.capability, arguments=item.arguments
        )
        res = channel.call_host(params)
        return Observation(
            callId=item.callId,
            capability=item.capability,
            ok=res.ok,
            payload=dict(res.model_extra or {}),
            arguments=item.arguments,
        )

    start_time = time.perf_counter()
    observations = execute_tool_calls_batched(calls, _exec, max_workers=2)
    elapsed = time.perf_counter() - start_time

    # 契约底线断言：必须返回 2 条结果，且保序返回
    assert len(observations) == 2
    assert observations[0].callId == "c1"
    assert observations[1].callId == "c2"
    # 并发耗时判定（串行将 >= 0.10s）
    assert elapsed < 0.09, f"并发执行耗时偏长: {elapsed:.3f}s"
    assert all(obs.ok for obs in observations)


def test_batch_fault_tolerance_isolation():
    """场景：同批调用中某一个工具执行抛出异常或失败，不得中断同批其他工具，全部结果结构化收集。"""
    register_capabilities(SAMPLE_DESCRIPTORS)
    calls = [
        ToolCallItem(callId="c1", capability="file_read", arguments={"path": "missing.py"}),
        ToolCallItem(callId="c2", capability="file_read", arguments={"path": "exist.py"}),
    ]

    results = {
        "c1": RuntimeError("Host IO error: file not found"),
        "c2": {"ok": True, "content": "content of exist", "totalLines": 1},
    }
    channel = ConcurrentFakeChannel(results)

    def _exec(item: ToolCallItem) -> Observation:
        params = HostExecuteToolParams(
            callId=item.callId, capability=item.capability, arguments=item.arguments
        )
        res = channel.call_host(params)
        return Observation(
            callId=item.callId,
            capability=item.capability,
            ok=res.ok,
            payload=dict(res.model_extra or {}),
            arguments=item.arguments,
        )

    observations = execute_tool_calls_batched(calls, _exec, max_workers=2)

    # 契约底线断言：故障隔离，两项均返回，c1 为 False，c2 为 True
    assert len(observations) == 2
    assert observations[0].callId == "c1"
    assert observations[0].ok is False
    assert "Host IO error" in str(observations[0].payload.get("error", ""))
    assert observations[1].callId == "c2"
    assert observations[1].ok is True
    assert observations[1].payload.get("content") == "content of exist"


def test_react_loop_supports_batch_tool_calls():
    """场景：ReAct 循环单轮消费 BatchToolCallDecision，并在下一轮生成 SummaryDecision。"""
    register_capabilities(SAMPLE_DESCRIPTORS)
    batch_decision = BatchToolCallDecision(
        kind="batch_tool_call",
        calls=[
            ToolCallItem(callId="c1", capability="file_read", arguments={"path": "a.py"}),
            ToolCallItem(callId="c2", capability="file_search", arguments={"pattern": "*.py"}),
        ],
    )
    summary_decision = SummaryDecision(
        kind="summary",
        reply="已检索并读取代码",
        facts=[],
    )

    decisions = [batch_decision, summary_decision]
    model = ScriptedModel(decisions)
    channel = ConcurrentFakeChannel({
        "c1": {"ok": True, "content": "print('hello')", "totalLines": 1},
        "c2": {"ok": True, "matches": [{"path": "a.py"}]},
    })
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
    )

    outcome = loop.run(
        goal="查找代码并读取",
        visible_capabilities=["file_read", "file_search"],
    )

    # 契约底线断言
    assert isinstance(outcome, ReActOutcome)
    assert outcome.kind == "completed"
    assert outcome.reply == "已检索并读取代码"
    assert outcome.steps_used == 2
    assert outcome.tool_calls_used == 2
    assert len(context.observations) == 2
    assert context.observations[0].callId == "c1"
    assert context.observations[1].callId == "c2"
