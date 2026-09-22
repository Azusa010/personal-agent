"""状态栏（Status Bar）核心数据模型与契约定义。"""

from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TodoStatus(str, Enum):
    """任务项状态枚举。"""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class TodoItem(BaseModel):
    """单个 TODO 任务规划项。"""

    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, description="任务项唯一标识，如 todo-1")
    content: str = Field(min_length=1, description="任务规划步骤的具体内容")
    status: TodoStatus = Field(
        default=TodoStatus.PENDING, description="当前步骤状态"
    )
    timestamp: str = Field(
        min_length=1,
        description="状态创建或最后更新时间戳，格式 [YYYY-MM-DD HH:MM:SS] 或标准 ISO",
    )


class ToolCounterState(BaseModel):
    """全局工具调用计数状态。"""

    model_config = ConfigDict(extra="allow")

    calls_per_tool: dict[str, int] = Field(
        default_factory=dict, description="每个工具名称对应被调用的次数字典"
    )
    total_calls: int = Field(default=0, ge=0, description="所有工具累计调用总次数")


class SystemEnvironment(BaseModel):
    """宿主系统环境感知状态。"""

    model_config = ConfigDict(extra="allow")

    current_time: str = Field(
        min_length=1, description="宿主当前时间（带时区或标准格式）"
    )
    cwd: str = Field(min_length=1, description="当前工作目录路径")
    os_type: str = Field(min_length=1, description="操作系统名称及内核版本")
    shell: str = Field(min_length=1, description="当前检测到的 Shell 环境（PowerShell/Bash等）")
    python_version: str = Field(
        min_length=1, description="当前运行的 Python 版本号"
    )
    extra: dict[str, Any] = Field(
        default_factory=dict, description="额外系统上下文（如架构、用户等）"
    )


class StatusBarState(BaseModel):
    """状态栏整体聚合状态快照。"""

    model_config = ConfigDict(extra="allow")

    todos: list[TodoItem] = Field(
        default_factory=list, description="任务规划清单"
    )
    tool_counter: ToolCounterState = Field(
        default_factory=ToolCounterState, description="工具调用计数器状态"
    )
    system_env: SystemEnvironment | None = Field(
        default=None, description="系统环境状态快照"
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        description="状态快照更新时间",
    )
