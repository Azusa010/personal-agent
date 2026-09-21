"""AgentStrategy 策略测试。

覆盖：
1. ClassicStrategy、ReActStrategy、PlanAndExecuteStrategy 均实现 AgentStrategy 契约
2. ClassicStrategy 保留已有 engine 确定性逻辑
3. resolve_strategy 环境分流判定
4. ReActStrategy 与 PlanAndExecuteStrategy 的运行流程
"""



from personal_agent.engine import Budget
from personal_agent.model_gateway import SummaryDecision, ToolCallDecision
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskCompleted,
)
from personal_agent.runtime import SCRIPT_ENV, STRATEGY_ENV, resolve_strategy
from personal_agent.scripted_model import ScriptedModel
from personal_agent.strategy import (
    AgentStrategy,
    ClassicStrategy,
    PlanAndExecuteStrategy,
    ReActStrategy,
)

VISIBLE = ["filesystem_list", "document_extract_pdf"]


class FakeChannel:
    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def call_host(self, params: HostExecuteToolParams):
        self.calls.append(params)
        if not self._results:
            raise AssertionError("FakeChannel 预设结果已用尽")
        item = self._results.pop(0)
        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


def list_result():
    return {
        "ok": True,
        "entries": [
            {
                "name": "a.pdf",
                "absolutePath": "D:/downloads/a.pdf",
                "modifiedAt": "2026-09-01T00:00:00Z",
                "sizeBytes": 2048,
            }
        ],
    }


def test_strategies_implement_agent_strategy_protocol():
    """三大策略必须都满足 AgentStrategy 接口契约。"""
    assert isinstance(ClassicStrategy(), AgentStrategy)
    assert isinstance(ReActStrategy(), AgentStrategy)
    assert isinstance(PlanAndExecuteStrategy(), AgentStrategy)


def test_resolve_strategy_env_routing(monkeypatch):
    """验证 resolve_strategy 的环境变量解析优先级。"""
    # 1. 剧本优先 -> ClassicStrategy
    monkeypatch.setenv(SCRIPT_ENV, "path/to/script.json")
    monkeypatch.setenv(STRATEGY_ENV, "react")
    assert isinstance(resolve_strategy(), ClassicStrategy)

    # 2. 无剧本 + STRATEGY_ENV=react -> ReActStrategy
    monkeypatch.delenv(SCRIPT_ENV, raising=False)
    monkeypatch.setenv(STRATEGY_ENV, "react")
    assert isinstance(resolve_strategy(), ReActStrategy)

    # 3. 无剧本 + STRATEGY_ENV=plan_execute -> PlanAndExecuteStrategy
    monkeypatch.setenv(STRATEGY_ENV, "plan_execute")
    assert isinstance(resolve_strategy(), PlanAndExecuteStrategy)

    # 4. 默认无配置 -> PlanAndExecuteStrategy
    monkeypatch.delenv(STRATEGY_ENV, raising=False)
    assert isinstance(resolve_strategy(), PlanAndExecuteStrategy)


def test_classic_strategy_executes_golden_path():
    """ClassicStrategy 必须完美无损地跑通 Golden Path 任务。"""
    strategy = ClassicStrategy()
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="扫描完毕",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([list_result()])
    plan = [
        PlanStepDto(description="列出文件", capability="filesystem_list"),
        PlanStepDto(description="直接总结"),
    ]

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="扫描文件",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(),
        stream=None,
    )

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    assert result.reply == "扫描完毕"
