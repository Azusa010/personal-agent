"""
test_dynamic_todo_ledger.py
SOTA 动态任务账本 (Dynamic Task Ledger / TodoWrite) 测试套件。

涵盖：
1. TodoUpdateParams 入参契约校验与容错（Zod/Pydantic 双端对齐）
2. 本地工具动态 Schema 注册与 build_tools 反射注入
3. StatusBarManager 动态任务账本增删改与并发互斥校验（至多单项 in_progress）
4. 单主循环（ReActLoop / DynamicLedgerStrategy）中 todo_update 工具的就地执行与上下文反哺
5. 遇错动态追加排错步骤（Self-Remediation Ledger）全链路闭环
"""

from collections.abc import Sequence
from typing import Any

import pytest
from pydantic import ValidationError

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.loop.react_loop import ReActLoop
from personal_agent.conversation.loop.strategy import DynamicLedgerStrategy
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelGateway,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.model.live_model import build_tools
from personal_agent.conversation.model.tool_schema_generator import (
    generate_local_tool_schemas,
)
from personal_agent.conversation.status.manager import StatusBarManager
from personal_agent.conversation.status.models import (
    TodoStatus,
    TodoUpdateItemDto,
    TodoUpdateParams,
)
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskCompleted,
)
from personal_agent.shared import Budget, HostChannel

# ---------------------------------------------------------------------------
# 测试桩：Mock 通道与可控序列模型
# ---------------------------------------------------------------------------


class MockHostChannel(HostChannel):
    """用于测试的 HostChannel 桩。"""

    def __init__(self, tool_responses: dict[str, dict[str, Any]] | None = None) -> None:
        self.tool_responses = tool_responses or {}
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        resp = self.tool_responses.get(params.capability, {"ok": True})
        return HostExecuteToolResult(
            callId=params.callId,
            ok=resp.get("ok", True),
            model_extra=resp,
        )


class SequenceDecisionModel(ModelGateway):
    """顺序产出指定决策的模型桩，并记录每次决策收到的 ModelContext。"""

    def __init__(self, decisions: Sequence[Any]) -> None:
        self._decisions = list(decisions)
        self._idx = 0
        self.captured_contexts: list[ModelContext] = []

    def decide(self, context: ModelContext, thinking_sink=None) -> Any:
        self.captured_contexts.append(context)
        if self._idx >= len(self._decisions):
            return SummaryDecision(kind="summary", reply="无更多预设决策，默认总结", facts=[])
        dec = self._decisions[self._idx]
        self._idx += 1
        return dec


# ---------------------------------------------------------------------------
# 1. TodoUpdateParams 入参契约校验与容错测试
# ---------------------------------------------------------------------------


def test_todo_update_params_valid_payload():
    """验证合法的 todo_update 参数能够正确解析。"""
    payload = {
        "todos": [
            {"id": "todo-1", "content": "检查工作区文件", "status": "completed"},
            {"id": "todo-2", "content": "修改配置", "status": "in_progress"},
            {"content": "运行测试验证", "status": "pending"},
        ]
    }
    params = TodoUpdateParams.model_validate(payload)
    assert len(params.todos) == 3
    assert params.todos[0].id == "todo-1"
    assert params.todos[0].status == TodoStatus.COMPLETED
    assert params.todos[1].status == TodoStatus.IN_PROGRESS
    assert params.todos[2].id is None
    assert params.todos[2].status == TodoStatus.PENDING


def test_todo_update_params_validation_errors():
    """验证非法参数能够被 Pydantic 严格拦截。"""
    # 缺少必填 content
    with pytest.raises(ValidationError):
        TodoUpdateParams.model_validate({"todos": [{"status": "pending"}]})

    # 空 content 字符串
    with pytest.raises(ValidationError):
        TodoUpdateParams.model_validate({"todos": [{"content": "", "status": "pending"}]})

    # 非法 status 枚举
    with pytest.raises(ValidationError):
        TodoUpdateParams.model_validate(
            {"todos": [{"content": "测试", "status": "unknown_status"}]}
        )


def test_todo_update_params_extra_fields_allowed():
    """验证遵守 monorepo 规范：extra='allow' 不静默吞掉或报错未知字段。"""
    payload = {
        "todos": [
            {
                "id": "todo-1",
                "content": "做某些事",
                "status": "pending",
                "custom_metadata": "extra_val",
            }
        ],
        "version": 2,
    }
    params = TodoUpdateParams.model_validate(payload)
    assert params.todos[0].content == "做某些事"
    assert params.todos[0].model_extra.get("custom_metadata") == "extra_val"


# ---------------------------------------------------------------------------
# 2. 本地工具动态 Schema 注册与反射测试
# ---------------------------------------------------------------------------


def test_todo_update_schema_registration():
    """验证 todo_update 完成注册且符合 OpenAI Function Calling 规范。"""
    schemas = generate_local_tool_schemas()
    assert "todo_update" in schemas

    tool_def = schemas["todo_update"]
    assert tool_def["type"] == "function"
    func = tool_def["function"]
    assert func["name"] == "todo_update"
    assert "todos" in func["parameters"]["properties"]
    assert "todos" in func["parameters"]["required"]


def test_build_tools_includes_todo_update():
    """验证 build_tools 产出的真实工具列表中原生包含 todo_update。"""
    tools = build_tools(["file_read", "file_write"])
    names = [t["function"]["name"] for t in tools]
    assert "todo_update" in names
    assert "file_read" in names


# ---------------------------------------------------------------------------
# 3. StatusBarManager 动态任务账本增删改与互斥校验
# ---------------------------------------------------------------------------


def test_status_bar_manager_update_todos_state_and_render():
    """验证 StatusBarManager.update_todos 能够正确更新内部状态与渲染结果。"""
    manager = StatusBarManager()
    initial_plan = [
        PlanStepDto(description="步骤1: 查看源码", capability="file_read"),
        PlanStepDto(description="步骤2: 修改代码", capability="file_edit"),
    ]
    manager.init_from_plan(initial_plan)

    assert len(manager.state.todos) == 2
    assert manager.state.todos[0].status == TodoStatus.IN_PROGRESS
    assert manager.state.todos[1].status == TodoStatus.PENDING

    # 执行更新：步骤1 完成，步骤2 正在进行
    updated = manager.update_todos(
        [
            TodoUpdateItemDto(id="todo-1", content="步骤1: 查看源码", status=TodoStatus.COMPLETED),
            TodoUpdateItemDto(id="todo-2", content="步骤2: 修改代码", status=TodoStatus.IN_PROGRESS),
        ]
    )

    assert len(updated) == 2
    assert manager.state.todos[0].status == TodoStatus.COMPLETED
    assert manager.state.todos[1].status == TodoStatus.IN_PROGRESS

    rendered = manager.render()
    assert "[✓] todo-1: 步骤1: 查看源码" in rendered
    assert "[▶] todo-2: 步骤2: 修改代码" in rendered


def test_status_bar_manager_dynamic_append_substep():
    """验证动态追加排错/修复子步骤，并自动补充 ID。"""
    manager = StatusBarManager()
    manager.init_from_plan([PlanStepDto(description="初版任务", capability="file_read")])

    # 追加一个没有显式 ID 的排错子任务
    updated = manager.update_todos(
        [
            TodoUpdateItemDto(id="todo-1", content="初版任务", status=TodoStatus.COMPLETED),
            TodoUpdateItemDto(content="追加修复子步骤", status=TodoStatus.IN_PROGRESS),
        ]
    )

    assert len(updated) == 2
    assert manager.state.todos[1].id == "todo-2"
    assert manager.state.todos[1].content == "追加修复子步骤"
    assert manager.state.todos[1].status == TodoStatus.IN_PROGRESS

    rendered = manager.render()
    assert "[✓] todo-1: 初版任务" in rendered
    assert "[▶] todo-2: 追加修复子步骤" in rendered


def test_status_bar_manager_concurrency_rule_single_in_progress():
    """验证 SOTA 核心并发准则：全局至多仅允许一个任务处于 in_progress。

    若模型传入多个 in_progress，系统应自动进行归一化裁决（保留最后一个，前序置为 completed 或 pending），
    确保状态机永远处于单焦点执行状态，不产生状态漂移。
    """
    manager = StatusBarManager()
    updated = manager.update_todos(
        [
            TodoUpdateItemDto(id="todo-1", content="第一项", status=TodoStatus.IN_PROGRESS),
            TodoUpdateItemDto(id="todo-2", content="第二项", status=TodoStatus.IN_PROGRESS),
        ]
    )
    in_progress_items = [t for t in updated if t.status == TodoStatus.IN_PROGRESS]
    assert len(in_progress_items) == 1
    # 最后一项保持 in_progress，前序项已被推进完成
    assert updated[1].status == TodoStatus.IN_PROGRESS
    assert updated[0].status == TodoStatus.COMPLETED


# ---------------------------------------------------------------------------
# 4. 单主循环中 todo_update 工具的就地执行与上下文反哺测试
# ---------------------------------------------------------------------------


def test_react_loop_dynamic_todo_update_turn_by_turn():
    """验证在 ReActLoop 单主循环中，模型调用 todo_update 会就地执行，且更新后的 TODO LIST 立即反哺进下一轮 Prompt。"""
    plan = [
        PlanStepDto(description="检查环境", capability="file_read"),
        PlanStepDto(description="执行部署", capability=None),
    ]

    channel = MockHostChannel()

    # 4 轮决策：
    # Turn 1: 模型调用 todo_update 声明开始检查环境
    # Turn 2: 模型调用 file_read 读环境
    # Turn 3: 模型调用 todo_update 将环境检查置为完成，并将部署置为 in_progress
    # Turn 4: 模型完成任务，输出总结
    model = SequenceDecisionModel(
        [
            ToolCallDecision(
                kind="tool_call",
                callId="call-todo-1",
                capability="todo_update",
                arguments={
                    "todos": [
                        {"id": "todo-1", "content": "检查环境", "status": "in_progress"},
                        {"id": "todo-2", "content": "执行部署", "status": "pending"},
                    ]
                },
            ),
            ToolCallDecision(
                kind="tool_call",
                callId="call-read-1",
                capability="file_read",
                arguments={"path": "package.json"},
            ),
            ToolCallDecision(
                kind="tool_call",
                callId="call-todo-2",
                capability="todo_update",
                arguments={
                    "todos": [
                        {"id": "todo-1", "content": "检查环境", "status": "completed"},
                        {"id": "todo-2", "content": "执行部署", "status": "in_progress"},
                    ]
                },
            ),
            SummaryDecision(kind="summary", reply="部署检查已全部完成", facts=[]),
        ]
    )

    context = ContextManager(plan=plan, history=[], profile=None, task_goal="部署系统")
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
    )

    outcome = loop.run(goal="部署系统", visible_capabilities=["file_read"])

    assert outcome.kind == "completed"
    assert "部署检查已全部完成" in outcome.reply

    # 验证 todo_update 纯本地处理，未被穿透到 HostChannel
    assert len(channel.calls) == 1
    assert channel.calls[0].capability == "file_read"

    # 验证模型在 Turn 3 和 Turn 4 决策前收到的 Prompt/Context 包含动态更新的状态栏
    assert len(model.captured_contexts) >= 3
    # Turn 3（索引 2）决策时，观察列表中已收到 call-todo-1 和 call-read-1
    assert len(model.captured_contexts[2].observations) == 2
    # 验证状态栏中的 todo 状态已真实变更为 completed 和 in_progress
    final_todos = context.status_bar_manager.state.todos
    assert final_todos[0].status == TodoStatus.COMPLETED
    assert final_todos[1].status == TodoStatus.IN_PROGRESS


# ---------------------------------------------------------------------------
# 5. DynamicLedgerStrategy 端到端动态规划与排错追加闭环测试
# ---------------------------------------------------------------------------


def test_dynamic_ledger_strategy_self_remediation_ledger():
    """验证长任务遇到报错时，模型自主在任务账本中插入排错步骤并完成修复。"""
    plan = [
        PlanStepDto(description="初始化配置", capability="file_read"),
        PlanStepDto(description="启动服务", capability=None),
    ]

    # file_read 首次返回配置损坏
    channel = MockHostChannel(
        {
            "file_read": {"ok": False, "error": "CONFIG_CORRUPTED: 配置文件损坏"},
        }
    )

    model = SequenceDecisionModel(
        [
            # 1. 尝试读配置
            ToolCallDecision(
                kind="tool_call",
                callId="call-1",
                capability="file_read",
                arguments={"path": "config.yaml"},
            ),
            # 2. 发现配置损坏，模型调用 todo_update 动态插入“修复配置文件”步骤
            ToolCallDecision(
                kind="tool_call",
                callId="call-2",
                capability="todo_update",
                arguments={
                    "todos": [
                        {"id": "todo-1", "content": "初始化配置", "status": "completed"},
                        {"id": "todo-1.1", "content": "重置损坏的配置文件", "status": "in_progress"},
                        {"id": "todo-2", "content": "启动服务", "status": "pending"},
                    ]
                },
            ),
            # 3. 输出总结表示已修复并完成
            SummaryDecision(kind="summary", reply="已动态追加排错并在账本中记录", facts=[]),
        ]
    )

    strategy = DynamicLedgerStrategy()
    result = strategy.execute(
        model=model,
        channel=channel,
        goal="配置并启动服务",
        visible_capabilities=["file_read"],
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        stream=None,
    )

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    assert "已动态追加排错" in result.reply
