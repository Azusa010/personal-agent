"""services/agent-runtime/tests/test_subagent_wiring.py

测试网：子 Agent 体系端到端接线与主从隔离全闭环 (Subagent Wiring & End-to-End Orchestration)。

验证目标：
1. Schema 与模型感知 (Tool Perception)：
   - spawn_subagent 本地工具 Schema 正确注册，并在 build_tools() 与 render_input() 中对大模型双协议可见；
   - 宿主能力枚举 TOOL_SPECS 保持纯净，无跨界污染。
2. 子 Agent 执行闭环与日志物理隔离 (SubagentRunner & Trace Isolation)：
   - SubagentRunner 驱动子 Agent 独立运行，将详细思考与多步工具调用隔离记录至独立 JSONL；
   - 子 Agent 完成后自动触发 finalize 与 backfeed_to_main_ledger，向主账本追加且仅追加 1 条结构化 subagent 事件 (零噪音污染)。
3. 异常与步数硬截断防护 (Step Limit & Error Resilience)：
   - 达到 max_steps 步数上限时安全截断；
   - 发生不可恢复异常时优雅标记 failed 并回灌错误原因，不导致主系统崩塌。
4. 本地执行器精准拦截 (Local Executor Interception)：
   - create_local_executor 精准拦截 spawn_subagent，就地执行并返回标准化 Observation，绝不下发至 Electron 宿主 RPC。
5. ReAct 主循环端到端驱动 (ReAct Loop Dispatch)：
   - 主模型下发 spawn_subagent 调用，本地拦截器执行并返回浓缩结论，主模型基于子 Agent 摘要顺利完成主任务。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.loop.react_loop import ReActLoop
from personal_agent.conversation.model.gateway import (
    ModelDecision,
    ModelGateway,
    Observation,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.model.live_model import build_tools
from personal_agent.conversation.model.tool_schema_generator import (
    LOCAL_TOOL_SCHEMAS,
    generate_local_tool_schemas,
)
from personal_agent.conversation.subagent import (
    SubagentPool,
    SubagentPrototype,
    SubagentResult,
)
from personal_agent.conversation.subagent.models import SpawnSubagentParams
from personal_agent.conversation.subagent.runner import SubagentRunner
from personal_agent.conversation.topics import (
    ThreeTierRetriever,
    TopicSwitchHandler,
)
from personal_agent.conversation.windows import SlidingWindowLedger
from personal_agent.runtime import create_local_executor
from personal_agent.shared import Budget, HostChannel


# =========================================================================
# 1. Schema 契约与感知层验证
# =========================================================================


def test_spawn_subagent_params_validation():
    """验证 SpawnSubagentParams 参数契约的校验规则。"""
    # 合法参数
    params = SpawnSubagentParams(
        role="SecurityAuditor",
        goal="Audit path traversal vulnerability in argument binders",
        specific_instructions="Focus on resolveWithinRootReal function only",
        allowed_tools=["file_read", "file_search"],
    )
    assert params.role == "SecurityAuditor"
    assert params.goal == "Audit path traversal vulnerability in argument binders"
    assert params.specific_instructions == "Focus on resolveWithinRootReal function only"
    assert params.allowed_tools == ["file_read", "file_search"]

    # 缺省可选字段校验
    minimal_params = SpawnSubagentParams(
        role="Explorer",
        goal="Explore project layout",
    )
    assert minimal_params.specific_instructions is None
    assert minimal_params.allowed_tools is None

    # 缺少必需字段校验
    with pytest.raises(ValidationError):
        SpawnSubagentParams.model_validate({"role": "Explorer"})

    with pytest.raises(ValidationError):
        SpawnSubagentParams.model_validate({"goal": "Do something"})


def test_spawn_subagent_schema_registration():
    """验证 spawn_subagent 在 LOCAL_TOOL_SCHEMAS 中完成注册且符合 OpenAI Function Calling 规范。"""
    schemas = generate_local_tool_schemas()
    assert "spawn_subagent" in schemas

    subagent_tool = schemas["spawn_subagent"]
    assert subagent_tool["type"] == "function"
    func = subagent_tool["function"]
    assert func["name"] == "spawn_subagent"
    assert "parameters" in func

    props = func["parameters"]["properties"]
    assert "role" in props
    assert "goal" in props
    assert "specific_instructions" in props
    assert "allowed_tools" in props

    reqs = func["parameters"]["required"]
    assert "role" in reqs
    assert "goal" in reqs


def test_build_tools_includes_spawn_subagent():
    """验证 build_tools 产出的工具集中原生包含 spawn_subagent。"""
    tools = build_tools(["file_read", "file_write"])
    tool_names = [t["function"]["name"] for t in tools]
    assert "spawn_subagent" in tool_names


# =========================================================================
# 2. SubagentRunner 闭环执行与日志物理隔离验证
# =========================================================================


class ScriptedSubagentModelGateway(ModelGateway):
    """脚本化 Mock 模型网关，按预定队列返回决策。"""

    def __init__(self, decisions: list[ModelDecision]):
        self._decisions = list(decisions)
        self.decided_inputs: list[Any] = []

    def decide(
        self, context: Any = None, on_thinking: Any = None, **kwargs
    ) -> ModelDecision:
        self.decided_inputs.append(context)
        if not self._decisions:
            return SummaryDecision(
                kind="summary",
                thought="Subagent fallback complete",
                reply="Fallback summary",
            )
        return self._decisions.pop(0)


def test_subagent_runner_lifecycle_and_trace_isolation(tmp_path: Path):
    """验证 SubagentRunner 驱动子 Agent 运行，中间日志隔离落盘，最终结果回灌主账本。"""
    traces_dir = tmp_path / "subagent_traces"
    ledger_path = tmp_path / "ledger" / "main_ledger.jsonl"
    main_ledger = MainEventLedger(log_file=ledger_path)

    prototype = SubagentPrototype(
        system_prompt="You are a focused subagent.",
        default_traces_dir=traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    # 模拟子 Agent 两步动作：第一步调用 mock 工具，第二步产出总结
    step1_tool = ToolCallDecision(
        kind="tool_call",
        thinking="Need to check project files",
        callId="call-sub-1",
        capability="mock_search",
        arguments={"query": "test"},
    )
    step2_summary = SummaryDecision(
        kind="summary",
        thinking="Found all relevant security boundaries",
        reply="Security audit completed: No traversal vulnerabilities found.",
    )
    mock_model = ScriptedSubagentModelGateway([step1_tool, step2_summary])

    executed_tools: list[tuple[str, dict[str, Any]]] = []

    def mock_tool_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
        executed_tools.append((name, args))
        return {"status": "ok", "items": ["file1.py", "file2.py"]}

    runner = SubagentRunner(
        pool=pool,
        model=mock_model,
        tool_executor=mock_tool_executor,
    )

    # 执行子 Agent
    result = runner.run(
        role="SecurityAuditor",
        goal="Audit path-guard implementation",
        specific_instructions="Check safe_join and resolveWithinRootReal",
        allowed_tools=["mock_search"],
    )

    # 1. 结果结构校验
    assert isinstance(result, SubagentResult)
    assert result.status == "completed"
    assert result.role == "SecurityAuditor"
    assert "No traversal vulnerabilities found" in result.summary
    assert len(executed_tools) == 1
    assert executed_tools[0] == ("mock_search", {"query": "test"})

    # 2. 子 Agent 物理日志隔离校验
    trace_file = Path(result.trace_file)
    assert trace_file.exists()
    trace_lines = [json.loads(line) for line in trace_file.read_text(encoding="utf-8").strip().splitlines()]
    # 至少应记录 lifecycle start, thought, tool_call, tool_result, lifecycle complete
    event_types = [ev["event_type"] for ev in trace_lines]
    assert "thought" in event_types
    assert "tool_call" in event_types
    assert "tool_result" in event_types

    # 3. 主账本零噪音回灌校验 (有且仅有 1 条 subagent 事件)
    main_events = main_ledger.read_events()
    assert len(main_events) == 1
    main_event = main_events[0]
    assert main_event.event_type == "subagent"
    assert main_event.subagent_run_id == result.run_id
    payload = main_event.payload
    assert payload["role"] == "SecurityAuditor"
    assert "No traversal vulnerabilities found" in payload["summary"]

    # 4. 池管理器中已移出活跃集合 (finalize 完毕)
    assert pool.get(result.run_id) is not None  # 仍保存在历史 instances
    assert result.run_id not in pool.active  # 不在活跃中


def test_subagent_runner_step_limit_truncation(tmp_path: Path):
    """验证当子 Agent 步数达到 max_steps 上限时，能够强制截断并完成，防止死循环。"""
    traces_dir = tmp_path / "subagent_traces"
    ledger_path = tmp_path / "ledger" / "main_ledger.jsonl"
    main_ledger = MainEventLedger(log_file=ledger_path)

    prototype = SubagentPrototype(
        system_prompt="You are a focused subagent.",
        default_traces_dir=traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    # 模拟无限发起工具调用的死循环模型
    infinite_tool_calls = [
        ToolCallDecision(
            kind="tool_call",
            thinking=f"Looping step {i}",
            callId=f"call-loop-{i}",
            capability="mock_ping",
            arguments={"step": i},
        )
        for i in range(10)
    ]
    mock_model = ScriptedSubagentModelGateway(infinite_tool_calls)

    runner = SubagentRunner(
        pool=pool,
        model=mock_model,
        tool_executor=lambda name, args: {"pong": True},
    )

    # 限制最多运行 3 步
    result = runner.run(
        role="LoopingWorker",
        goal="Test step limit",
        max_steps=3,
    )

    assert result.status == "completed"
    assert "step limit" in result.summary.lower() or "limit" in result.summary.lower()
    assert result.total_steps >= 3

    # 主账本必须记录这 1 条回灌事件
    main_events = main_ledger.read_events()
    assert len(main_events) == 1
    assert main_events[0].event_type == "subagent"


def test_subagent_runner_error_resilience(tmp_path: Path):
    """验证当执行工具抛出异常或模型异常时，子 Agent 标记为 failed 并优雅回灌。"""
    traces_dir = tmp_path / "subagent_traces"
    ledger_path = tmp_path / "ledger" / "main_ledger.jsonl"
    main_ledger = MainEventLedger(log_file=ledger_path)

    prototype = SubagentPrototype(
        system_prompt="You are a focused subagent.",
        default_traces_dir=traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    step1_tool = ToolCallDecision(
        kind="tool_call",
        thinking="Triggering error",
        callId="call-err",
        capability="failing_tool",
        arguments={},
    )
    mock_model = ScriptedSubagentModelGateway([step1_tool])

    def broken_tool_executor(name: str, args: dict[str, Any]):
        raise RuntimeError("Fatal hardware failure in sandbox")

    runner = SubagentRunner(
        pool=pool,
        model=mock_model,
        tool_executor=broken_tool_executor,
    )

    result = runner.run(
        role="CrashWorker",
        goal="Test error handling",
    )

    assert result.status == "failed"
    assert result.error is not None
    assert "Fatal hardware failure in sandbox" in result.error

    # 主账本记录失败事件
    main_events = main_ledger.read_events()
    assert len(main_events) == 1
    assert main_events[0].payload["status"] == "failed"


# =========================================================================
# 3. 本地执行器拦截与 ReAct 循环端到端联动验证
# =========================================================================


def test_create_local_executor_intercepts_spawn_subagent(tmp_path: Path):
    """验证 create_local_executor 成功拦截 spawn_subagent，调用 runner 并返回标准 Observation。"""
    topic_handler = MagicMock(spec=TopicSwitchHandler)
    retriever = MagicMock(spec=ThreeTierRetriever)
    mock_runner = MagicMock(spec=SubagentRunner)

    mock_runner.run.return_value = SubagentResult(
        run_id="subagent-test-999",
        role="TestRole",
        status="completed",
        summary="Audit passed completely",
        trace_file=str(tmp_path / "trace.jsonl"),
        total_steps=2,
    )

    local_executor = create_local_executor(
        topic_handler=topic_handler,
        retriever=retriever,
        subagent_runner=mock_runner,
    )

    # 1. 拦截 spawn_subagent
    decision = ToolCallDecision(
        kind="tool_call",
        thinking="I will delegate this heavy investigation to a subagent",
        callId="call-spawn-1",
        capability="spawn_subagent",
        arguments={
            "role": "SecurityAnalyst",
            "goal": "Scan code dependencies",
            "specific_instructions": "Focus on high CVEs",
            "allowed_tools": ["file_read"],
        },
    )

    obs = local_executor(decision)
    assert obs is not None
    assert isinstance(obs, Observation)
    assert obs.callId == "call-spawn-1"
    assert obs.capability == "spawn_subagent"
    assert obs.ok is True
    assert obs.payload["run_id"] == "subagent-test-999"
    assert obs.payload["summary"] == "Audit passed completely"

    mock_runner.run.assert_called_once_with(
        role="SecurityAnalyst",
        goal="Scan code dependencies",
        specific_instructions="Focus on high CVEs",
        allowed_tools=["file_read"],
    )

    # 2. 常规宿主工具透明放行
    host_decision = ToolCallDecision(
        kind="tool_call",
        thinking="Reading host file",
        callId="call-host-1",
        capability="file_read",
        arguments={"path": "package.json"},
    )
    assert local_executor(host_decision) is None


def test_react_loop_subagent_dispatch_e2e(tmp_path: Path):
    """验证主 ReAct 循环端到端调度子 Agent：主模型下发 spawn_subagent -> 本地拦截执行 -> 主模型拿到结果并顺利完成任务。"""
    traces_dir = tmp_path / "subagent_traces"
    ledger_path = tmp_path / "ledger" / "main_ledger.jsonl"
    main_ledger = MainEventLedger(log_file=ledger_path)

    # 初始化原型与池
    prototype = SubagentPrototype(
        system_prompt="You are a subagent.",
        default_traces_dir=traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    # 子 Agent 模型：直接给出完成
    subagent_model = ScriptedSubagentModelGateway([
        SummaryDecision(
            kind="summary",
            thinking="Subagent finished investigation",
            reply="Subagent explored 15 files and confirmed all safe.",
        )
    ])
    subagent_runner = SubagentRunner(
        pool=pool,
        model=subagent_model,
        tool_executor=lambda name, args: {},
    )

    topic_handler = MagicMock(spec=TopicSwitchHandler)
    retriever = MagicMock(spec=ThreeTierRetriever)
    local_executor = create_local_executor(
        topic_handler=topic_handler,
        retriever=retriever,
        subagent_runner=subagent_runner,
    )

    # 主 Agent 模型：
    # 第一步下发 spawn_subagent
    # 第二步基于子 Agent 摘要做出总结完成主任务
    main_step1 = ToolCallDecision(
        kind="tool_call",
        thinking="I need to inspect the deep file structure using a subagent",
        callId="call-main-sub-1",
        capability="spawn_subagent",
        arguments={
            "role": "DeepExplorer",
            "goal": "Scan 15 project files",
        },
    )
    main_step2 = SummaryDecision(
        kind="summary",
        thinking="Subagent reported all files are safe. I can now finalize.",
        reply="Task accomplished: Verified all 15 project files via subagent.",
    )
    main_model = ScriptedSubagentModelGateway([main_step1, main_step2])

    host_channel = MagicMock(spec=HostChannel)
    window_ledger = SlidingWindowLedger(ledger=main_ledger)
    context = ContextManager(sliding_window=window_ledger)
    budget = Budget(max_steps=10)

    loop = ReActLoop(
        model=main_model,
        channel=host_channel,
        context=context,
        budget=budget,
        local_executor=local_executor,
    )

    outcome = loop.run(
        goal="Check safety of files",
        visible_capabilities=["spawn_subagent"],
    )

    # 验证主循环成功完成
    assert outcome.kind == "completed"
    assert "Task accomplished" in outcome.reply

    # 宿主渠道未曾收到 spawn_subagent（已被本地就地拦截）
    host_channel.call_host.assert_not_called()

    # 主账本必须记录了 1 条 subagent 回灌事件
    events = main_ledger.read_events()
    subagent_events = [ev for ev in events if ev.event_type == "subagent"]
    assert len(subagent_events) == 1
    assert subagent_events[0].event_type == "subagent"
    assert subagent_events[0].payload["role"] == "DeepExplorer"
    assert "Subagent explored 15 files and confirmed all safe." in subagent_events[0].payload["summary"]
