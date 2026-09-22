"""状态栏区块提供者（Provider）体系与系统环境感知。"""

import os
import platform
from datetime import UTC, datetime
from typing import Protocol

from personal_agent.conversation.status.models import (
    StatusBarState,
    SystemEnvironment,
    TodoStatus,
)


def detect_system_environment(cwd: str | None = None) -> SystemEnvironment:
    """探测当前运行宿主的真实操作系统、Shell 环境、Python 版本与工作目录。
    """
    target_cwd = cwd or os.getcwd()
    current_time = datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    os_type = f"{platform.system()} {platform.release()}".strip()
    python_version = platform.python_version()
    if platform.system() == "Windows":
        if "PSModulePath" in os.environ:
            shell = "PowerShell"
        elif "COMSPEC" in os.environ and "cmd" in os.environ["COMSPEC"].lower():
            shell = "CMD"
        else:
            shell = "Windows Shell"
    else:
        env_shell = os.environ.get("SHELL", "")
        if env_shell:
            shell = os.path.basename(env_shell.strip())
        else:
            shell = "sh"
    return SystemEnvironment(
        current_time=current_time,
        cwd=target_cwd,
        os_type=os_type,
        shell=shell,
        python_version=python_version,
    )


class StatusBarSectionProvider(Protocol):
    """状态栏区块提供者接口协议。"""

    section_id: str
    priority: int  # 决定渲染顺序，数值越小越靠前

    def render(self, state: StatusBarState) -> str | None:
        """渲染对应的 Markdown 区块，返回 None 表示本轮不展示该区块。"""
        ...


class SystemInfoProvider:
    """系统环境信息区块提供者。"""

    section_id = "system_info"
    priority = 10

    def render(self, state: StatusBarState) -> str | None:
        env = state.system_env
        if env is None:
            return None

        lines = [
            "## 🖥️ 系统环境",
            f"- 当前时间: {env.current_time}",
            f"- 工作目录: {env.cwd}",
            f"- 操作系统: {env.os_type}",
            f"- Shell 环境: {env.shell}",
            f"- Python 版本: {env.python_version}",
        ]
        return "\n".join(lines)


class ToolStatsProvider:
    """工具调用统计区块提供者。"""

    section_id = "tool_stats"
    priority = 20

    def render(self, state: StatusBarState) -> str | None:
        counter = state.tool_counter
        lines = [
            "## 🛠️ 工具调用统计",
            f"- 累计调用: {counter.total_calls} 次",
        ]
        if counter.calls_per_tool:
            details = ", ".join(
                f"{tool}: {count}" for tool, count in counter.calls_per_tool.items()
            )
            lines.append(f"- 详细分布: {details}")
        else:
            lines.append("- 详细分布: （暂无调用）")

        return "\n".join(lines)


# TODO 状态显示符号映射
TODO_STATUS_ICONS: dict[TodoStatus, str] = {
    TodoStatus.COMPLETED: "[✓]",
    TodoStatus.IN_PROGRESS: "[▶]",
    TodoStatus.PENDING: "[ ]",
    TodoStatus.CANCELLED: "[✗]",
}


class TodoPlanProvider:
    """任务规划 (TODO LIST) 区块提供者。"""

    section_id = "todo_plan"
    priority = 30

    def render(self, state: StatusBarState) -> str | None:
        if not state.todos:
            return None

        lines = ["## 📋 任务规划 (TODO LIST)"]
        for todo in state.todos:
            icon = TODO_STATUS_ICONS.get(todo.status, "[ ]")
            lines.append(
                f"- {icon} {todo.id}: {todo.content} [{todo.status.value} @ {todo.timestamp}]"
            )
        return "\n".join(lines)
