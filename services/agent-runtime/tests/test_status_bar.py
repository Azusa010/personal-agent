"""状态栏单元测试：数据模型、工具计数器与时间戳跟踪。"""

import re
from datetime import datetime

import pytest
from pydantic import ValidationError

from personal_agent.conversation.status.models import (
    StatusBarState,
    SystemEnvironment,
    TodoItem,
    TodoStatus,
    ToolCounterState,
)
from personal_agent.conversation.status.tracker import (
    ToolCallTracker,
    format_timestamp,
    prefix_with_timestamp,
)


def test_models_todo_item_validation():
    # 合法项创建
    item = TodoItem(
        id="todo-1",
        content="提取 PDF 文档内容",
        status=TodoStatus.IN_PROGRESS,
        timestamp="[2026-09-22 08:00:00]",
    )
    assert item.id == "todo-1"
    assert item.status == TodoStatus.IN_PROGRESS
    assert item.content == "提取 PDF 文档内容"

    # 空字段校验拒绝
    with pytest.raises(ValidationError):
        TodoItem(id="", content="xxx", timestamp="2026-01-01")

    with pytest.raises(ValidationError):
        TodoItem(id="todo-2", content="", timestamp="2026-01-01")


def test_models_status_bar_state_snapshot():
    state = StatusBarState(
        todos=[
            TodoItem(
                id="todo-1",
                content="步骤1",
                status=TodoStatus.COMPLETED,
                timestamp="2026-09-22 08:00:00",
            )
        ],
        tool_counter=ToolCounterState(
            calls_per_tool={"filesystem_list": 2},
            total_calls=2,
        ),
        system_env=SystemEnvironment(
            current_time="2026-09-22 08:00:00 CST",
            cwd="D:/PersonalAgent",
            os_type="Windows 11",
            shell="PowerShell",
            python_version="3.13.3",
        ),
    )
    dumped = state.model_dump()
    assert len(dumped["todos"]) == 1
    assert dumped["tool_counter"]["total_calls"] == 2
    assert dumped["system_env"]["os_type"] == "Windows 11"


def test_timestamp_formatting():
    # 验证默认系统时间戳格式
    ts = format_timestamp()
    assert re.match(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$", ts)

    # 验证指定固定时间的格式化
    fixed_dt = datetime(2026, 9, 22, 8, 30, 45)
    assert format_timestamp(fixed_dt) == "[2026-09-22 08:30:45]"

    # 验证前缀追加
    prefixed = prefix_with_timestamp("任务目标：整理文件", fixed_dt)
    assert prefixed == "[2026-09-22 08:30:45] 任务目标：整理文件"


def test_tool_call_tracker_record():
    tracker = ToolCallTracker()

    # 边界情况：空白或空名字拦截
    with pytest.raises(ValueError, match="tool_name 不能为空"):
        tracker.record_call("")
    with pytest.raises(ValueError, match="tool_name 不能为空"):
        tracker.record_call("   ")

    # 正常计数累加
    assert tracker.record_call("read_file") == 1
    assert tracker.record_call("read_file") == 2
    assert tracker.record_call("write_file") == 1
    assert tracker.record_call("read_file") == 3

    assert tracker.get_count("read_file") == 3
    assert tracker.get_count("write_file") == 1
    assert tracker.get_count("unknown_tool") == 0
    assert tracker.total_calls == 4

    # counts 返回只读副本，不能影响内部
    snapshot = tracker.counts
    snapshot["read_file"] = 999
    assert tracker.get_count("read_file") == 3


def test_tool_call_tracker_format():
    tracker = ToolCallTracker()

    # 空工具名校验
    with pytest.raises(ValueError, match="tool_name 不能为空"):
        tracker.format_annotation("")

    # 显式传入 call_number
    anno = tracker.format_annotation("read_file", call_number=3)
    assert anno == "Tool call #3 for 'read_file'"

    # 显式传入非法 call_number
    with pytest.raises(ValueError, match="call_number 必须 >= 1"):
        tracker.format_annotation("read_file", call_number=0)

    # 未调用过且不传 call_number，应拒绝
    with pytest.raises(ValueError, match="未找到工具 'write_file' 的历史调用记录"):
        tracker.format_annotation("write_file")

    # 记录调用后自动使用当前计数
    tracker.record_call("document_extract_pdf")
    tracker.record_call("document_extract_pdf")
    assert tracker.format_annotation("document_extract_pdf") == "Tool call #2 for 'document_extract_pdf'"


def test_tool_call_tracker_to_state():
    tracker = ToolCallTracker()
    tracker.record_call("filesystem_list")
    tracker.record_call("filesystem_list")
    tracker.record_call("filesystem_move")

    state = tracker.to_state()
    assert isinstance(state, ToolCounterState)
    assert state.total_calls == 3
    assert state.calls_per_tool == {"filesystem_list": 2, "filesystem_move": 1}


# ==========================================
# 阶段 2：环境感知与 Provider 流水线测试
# ==========================================

from personal_agent.conversation.status.providers import (
    SystemInfoProvider,
    TodoPlanProvider,
    ToolStatsProvider,
    detect_system_environment,
)
from personal_agent.conversation.status.renderer import (
    STATUS_BAR_CLOSE_TAG,
    STATUS_BAR_OPEN_TAG,
    StatusBarRenderer,
)


def test_detect_system_environment(monkeypatch):
    # 真实宿主环境探测验证
    env = detect_system_environment()
    assert isinstance(env, SystemEnvironment)
    assert env.current_time != ""
    assert env.cwd != ""
    assert env.os_type != ""
    assert env.shell != ""
    assert env.python_version != ""

    # 指定自定义 cwd
    custom_env = detect_system_environment(cwd="D:/MyProject")
    assert custom_env.cwd == "D:/MyProject"

    # Mock Windows + PowerShell 场景
    monkeypatch.setattr("platform.system", lambda: "Windows")
    monkeypatch.setattr("platform.release", lambda: "11")
    monkeypatch.setenv("PSModulePath", "C:/PowerShell/Modules")
    win_env = detect_system_environment()
    assert win_env.os_type == "Windows 11"
    assert win_env.shell == "PowerShell"

    # Mock Linux + bash 场景
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("platform.release", lambda: "5.15.0")
    monkeypatch.delenv("PSModulePath", raising=False)
    monkeypatch.setenv("SHELL", "/bin/bash")
    linux_env = detect_system_environment()
    assert linux_env.os_type == "Linux 5.15.0"
    assert linux_env.shell == "bash"


def test_system_info_provider():
    provider = SystemInfoProvider()
    assert provider.section_id == "system_info"
    assert provider.priority == 10

    # state 没有 system_env 时返回 None
    empty_state = StatusBarState()
    assert provider.render(empty_state) is None

    # state 有 system_env 时正常渲染
    state = StatusBarState(
        system_env=SystemEnvironment(
            current_time="2026-09-22 08:00:00",
            cwd="D:/PersonalAgent",
            os_type="Windows 11",
            shell="PowerShell",
            python_version="3.13.3",
        )
    )
    rendered = provider.render(state)
    assert rendered is not None
    assert "## 🖥️ 系统环境" in rendered
    assert "- 工作目录: D:/PersonalAgent" in rendered
    assert "- Shell 环境: PowerShell" in rendered


def test_tool_stats_provider():
    provider = ToolStatsProvider()
    assert provider.section_id == "tool_stats"
    assert provider.priority == 20

    # 零调用
    state_zero = StatusBarState()
    rendered_zero = provider.render(state_zero)
    assert "## 🛠️ 工具调用统计" in rendered_zero
    assert "- 累计调用: 0 次" in rendered_zero
    assert "- 详细分布: （暂无调用）" in rendered_zero

    # 多工具调用
    state_active = StatusBarState(
        tool_counter=ToolCounterState(
            calls_per_tool={"filesystem_list": 2, "read_pdf": 1},
            total_calls=3,
        )
    )
    rendered_active = provider.render(state_active)
    assert "- 累计调用: 3 次" in rendered_active
    assert "filesystem_list: 2" in rendered_active
    assert "read_pdf: 1" in rendered_active


def test_todo_plan_provider():
    provider = TodoPlanProvider()
    assert provider.section_id == "todo_plan"
    assert provider.priority == 30

    # 空清单返回 None
    assert provider.render(StatusBarState(todos=[])) is None

    # 渲染带不同状态的 TODO
    todos = [
        TodoItem(
            id="todo-1",
            content="扫描文件夹",
            status=TodoStatus.COMPLETED,
            timestamp="2026-09-22 08:00:00",
        ),
        TodoItem(
            id="todo-2",
            content="提取报表",
            status=TodoStatus.IN_PROGRESS,
            timestamp="2026-09-22 08:01:00",
        ),
        TodoItem(
            id="todo-3",
            content="生成总结",
            status=TodoStatus.PENDING,
            timestamp="2026-09-22 08:00:00",
        ),
        TodoItem(
            id="todo-4",
            content="发送邮件（取消）",
            status=TodoStatus.CANCELLED,
            timestamp="2026-09-22 08:02:00",
        ),
    ]
    rendered = provider.render(StatusBarState(todos=todos))
    assert rendered is not None
    assert "## 📋 任务规划 (TODO LIST)" in rendered
    assert "- [✓] todo-1: 扫描文件夹 [completed @ 2026-09-22 08:00:00]" in rendered
    assert "- [▶] todo-2: 提取报表 [in_progress @ 2026-09-22 08:01:00]" in rendered
    assert "- [ ] todo-3: 生成总结 [pending @ 2026-09-22 08:00:00]" in rendered
    assert "- [✗] todo-4: 发送邮件（取消） [cancelled @ 2026-09-22 08:02:00]" in rendered


def test_status_bar_renderer():
    renderer = StatusBarRenderer()

    # 全空状态，返回空字符串
    empty_state = StatusBarState()
    # 注意：默认只有 ToolStats 会输出（即使 0 次），但如果没有 system_env 且没有 todos
    # 这里 ToolStats 依然会渲染 0 次统计
    # 让我们测试纯空 providers
    custom_renderer = StatusBarRenderer(providers=[])
    assert custom_renderer.render(empty_state) == ""

    # 完整渲染
    full_state = StatusBarState(
        system_env=SystemEnvironment(
            current_time="2026-09-22 08:00:00",
            cwd="D:/PersonalAgent",
            os_type="Windows 11",
            shell="PowerShell",
            python_version="3.13.3",
        ),
        tool_counter=ToolCounterState(
            calls_per_tool={"document_extract_pdf": 1},
            total_calls=1,
        ),
        todos=[
            TodoItem(
                id="todo-1",
                content="提取文档",
                status=TodoStatus.IN_PROGRESS,
                timestamp="2026-09-22 08:00:00",
            )
        ],
    )
    output = renderer.render(full_state)
    assert output.startswith(STATUS_BAR_OPEN_TAG)
    assert output.endswith(STATUS_BAR_CLOSE_TAG)
    assert "## 🖥️ 系统环境" in output
    assert "## 🛠️ 工具调用统计" in output
    assert "## 📋 任务规划 (TODO LIST)" in output

    # 验证按优先级排序：系统环境 (10) -> 工具统计 (20) -> 任务规划 (30)
    pos_sys = output.index("## 🖥️ 系统环境")
    pos_tools = output.index("## 🛠️ 工具调用统计")
    pos_todos = output.index("## 📋 任务规划 (TODO LIST)")
    assert pos_sys < pos_tools < pos_todos


def test_status_bar_renderer_extensibility():
    # 测试可扩展性：注册自定义 Provider
    class MemoryUsageProvider:
        section_id = "memory_usage"
        priority = 5  # 高优先级，应排在系统环境前面

        def render(self, state: StatusBarState) -> str | None:
            return "## 🧠 内存状态\n- 内存占用: 128 MB"

    renderer = StatusBarRenderer(
        providers=[
            SystemInfoProvider(),
            MemoryUsageProvider(),
        ]
    )
    state = StatusBarState(
        system_env=SystemEnvironment(
            current_time="2026-09-22 08:00:00",
            cwd="D:/PersonalAgent",
            os_type="Windows 11",
            shell="PowerShell",
            python_version="3.13.3",
        )
    )
    output = renderer.render(state)
    assert "## 🧠 内存状态" in output
    assert "## 🖥️ 系统环境" in output
    assert output.index("## 🧠 内存状态") < output.index("## 🖥️ 系统环境")
