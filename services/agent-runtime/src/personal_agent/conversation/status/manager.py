"""状态栏管理中枢（StatusBarManager）：生命周期协调、状态流转与消息装配。"""

from collections.abc import Sequence
from datetime import datetime
from typing import Any

from personal_agent.conversation.status.models import (
    StatusBarState,
    TodoItem,
    TodoStatus,
)
from personal_agent.conversation.status.providers import detect_system_environment
from personal_agent.conversation.status.pruner import safe_prune_status_bars
from personal_agent.conversation.status.renderer import StatusBarRenderer
from personal_agent.conversation.status.strategy import (
    DEFAULT_ALPHA,
    InjectionStrategy,
    evaluate_injection_strategy,
)
from personal_agent.conversation.status.tracker import (
    TIMESTAMP_FORMAT,
    ToolCallTracker,
)
from personal_agent.protocol.models import PlanStepDto


class StatusBarManager:
    """状态栏中枢管理器，聚合 TODO 规划流转、工具调用计数、环境感知与自适应消息装配。"""

    def __init__(
        self,
        renderer: StatusBarRenderer | None = None,
        tool_tracker: ToolCallTracker | None = None,
        alpha: float = DEFAULT_ALPHA,
    ) -> None:
        self._renderer = renderer or StatusBarRenderer()
        self._tool_tracker = tool_tracker or ToolCallTracker()
        self._alpha = alpha
        self._state = StatusBarState(
            tool_counter=self._tool_tracker.to_state(),
            system_env=detect_system_environment(),
        )
        self._n_updates: int = 0

    @property
    def state(self) -> StatusBarState:
        return self._state

    @property
    def tool_tracker(self) -> ToolCallTracker:
        return self._tool_tracker

    @property
    def update_count(self) -> int:
        return self._n_updates

    def init_from_plan(self, plan: Sequence[PlanStepDto]) -> list[TodoItem]:
        """根据初始任务计划初始化 TODO 清单。第一项置为 in_progress，其余置为 pending。"""
        now_str = datetime.now().strftime(TIMESTAMP_FORMAT)
        todos: list[TodoItem] = []
        for idx, step in enumerate(plan, start=1):
            status = TodoStatus.IN_PROGRESS if idx == 1 else TodoStatus.PENDING
            todos.append(
                TodoItem(
                    id=f"todo-{idx}",
                    content=step.description,
                    status=status,
                    timestamp=now_str,
                )
            )
        self._state.todos = todos
        return list(todos)

    def update_todo_status(
        self, todo_id: str, status: TodoStatus
    ) -> TodoItem | None:
        """更新指定 TODO 项的状态和更新时间戳。"""
        now_str = datetime.now().strftime(TIMESTAMP_FORMAT)
        for todo in self._state.todos:
            if todo.id == todo_id:
                todo.status = status
                todo.timestamp = now_str
                return todo
        return None

    def record_tool_call(self, tool_name: str) -> str:
        """记录一次工具调用，同步更新状态快照，并返回标注字符串。"""
        self._tool_tracker.record_call(tool_name)
        self._state.tool_counter = self._tool_tracker.to_state()
        return self._tool_tracker.format_annotation(tool_name)

    def refresh_system_env(self, cwd: str | None = None) -> None:
        """刷新系统环境状态。"""
        self._state.system_env = detect_system_environment(cwd=cwd)

    def render(self) -> str:
        """渲染当前状态栏 Markdown 文本。"""
        return self._renderer.render(self._state)

    def apply_to_messages(
        self,
        messages: list[dict[str, Any]],
        strategy: InjectionStrategy | None = None,
        auto_strategy: bool = False,
        s_tokens: int = 150,
        r_tokens: int = 500,
        context_used_ratio: float = 0.0,
    ) -> list[dict[str, Any]]:
        """将最新状态栏注入到消息列表中。

        若 auto_strategy 为 True，则调用 evaluate_injection_strategy 自主裁决。
        若选择 "replace" 模式，则先进行安全修剪（剔除旧状态栏），再在末尾追加最新状态栏。
        """
        sb_text = self.render()
        if not sb_text:
            return list(messages)

        # 决定注入策略
        active_strategy: InjectionStrategy
        if auto_strategy:
            active_strategy = evaluate_injection_strategy(
                s_tokens=s_tokens,
                r_tokens=r_tokens,
                n_turns=self._n_updates + 1,
                alpha=self._alpha,
                context_used_ratio=context_used_ratio,
            )
        else:
            active_strategy = strategy or "replace"

        # 处理历史旧状态栏
        if active_strategy == "replace":
            cleaned = safe_prune_status_bars(messages)
        else:
            cleaned = list(messages)

        # 在末尾注入最新状态栏
        cleaned.append({"role": "user", "content": sb_text})
        self._n_updates += 1
        return cleaned
