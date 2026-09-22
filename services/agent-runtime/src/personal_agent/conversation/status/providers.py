"""状态栏区块提供者（Provider）体系与系统环境感知。"""

import os
import platform
from datetime import datetime
from typing import Protocol

from personal_agent.conversation.status.models import (
    StatusBarState,
    SystemEnvironment,
    TodoItem,
    TodoStatus,
)


def detect_system_environment(cwd: str | None = None) -> SystemEnvironment:
    """探测当前运行宿主的真实操作系统、Shell 环境、Python 版本与工作目录。

    # TODO(你填)[工程与规范]: 跨平台系统环境感知与安全嗅探
    # 契约：
    # - 输入：cwd (str | None)，若提供则使用传入的 cwd，否则调用 os.getcwd()
    # - 字段探测要求：
    #   1. current_time: datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    #   2. cwd: 传入的 cwd 或 os.getcwd()
    #   3. os_type: 结合 platform.system() 与 platform.release()，如 "Windows 11" 或 "Linux 5.15.0"
    #   4. python_version: platform.python_version()，如 "3.13.3"
    #   5. shell: 跨平台 Shell 识别：
    #      - 若 platform.system() == "Windows":
    #        - 若环境变量中包含 "PSModulePath"，识别为 "PowerShell"
    #        - 否则若环境变量中 "COMSPEC" 存在且包含 "cmd"，识别为 "CMD"
    #        - 否则 fallback 到 "Windows Shell"
    #      - 否则（非 Windows 如 Linux/Darwin）：
    #        - 优先读取 os.environ.get("SHELL")，提取最后一截（如 "/bin/zsh" -> "zsh", "/bin/bash" -> "bash"）
    #        - 找不到则 fallback 到 "sh"
    # - 输出：构造并返回合法的 SystemEnvironment 实例
    # - 对应验收测试：tests/test_status_bar.py::test_detect_system_environment
    """
    raise NotImplementedError("TODO(你填)[工程与规范]: detect_system_environment 待实现")


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
