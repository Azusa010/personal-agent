"""状态栏追踪器：工具调用计数器与时间戳追踪。"""

from collections import defaultdict
from datetime import UTC, datetime

from personal_agent.conversation.status.models import ToolCounterState

TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


def format_timestamp(dt: datetime | None = None) -> str:
    """生成标准格式的时间戳前缀字符串：[YYYY-MM-DD HH:MM:SS]。

    若 dt 为 None 则获取当前系统本地时间。
    """
    target_dt = dt or datetime.now(UTC).astimezone()
    return f"[{target_dt.strftime(TIMESTAMP_FORMAT)}]"


def prefix_with_timestamp(text: str, dt: datetime | None = None) -> str:
    """为指定文本内容添加时间戳前缀：[YYYY-MM-DD HH:MM:SS] <text>。"""
    prefix = format_timestamp(dt)
    return f"{prefix} {text}"


class ToolCallTracker:
    """维护全局工具调用计数字典，支持原子递增与格式化标注。"""

    def __init__(self) -> None:
        self._counts: dict[str, int] = defaultdict(int)
        self._total_calls: int = 0

    @property
    def counts(self) -> dict[str, int]:
        """只读快照副本，防止外部就地修改内部字典。"""
        return dict(self._counts)

    @property
    def total_calls(self) -> int:
        """累计调用总次数。"""
        return self._total_calls

    def get_count(self, tool_name: str) -> int:
        """获取指定工具的累计调用次数（未调用过返回 0）。"""
        return self._counts.get(tool_name, 0)

    def record_call(self, tool_name: str) -> int:
        """记录一次工具调用并返回该工具的当前累计次数（从 1 起算）。
        """
        if not tool_name or tool_name.strip() == "":
            raise ValueError("tool_name 不能为空")
        normalized_name = tool_name.strip()
        self._counts[normalized_name] += 1
        self._total_calls += 1
        return self._counts[normalized_name]

    def format_annotation(self, tool_name: str, call_number: int | None = None) -> str:
        """生成符合契约的工具调用标注字符串。

        格式规范：\"Tool call #<N> for '<tool_name>'\"
        示例：\"Tool call #3 for 'document_extract_pdf'\"
        """
        if not tool_name or tool_name.strip() == "":
            raise ValueError("tool_name 不能为空")
        normalized_name = tool_name.strip()
        if call_number is None:
            call_number = self.get_count(normalized_name)
            if call_number <= 0:
                raise ValueError(
                    f"未找到工具 '{normalized_name}' 的历史调用记录，必须显式传入 call_number"
                )
        if call_number is not None and call_number < 1:
            raise ValueError("call_number 必须 >= 1")
        return f"Tool call #{call_number} for '{normalized_name}'"

    def to_state(self) -> ToolCounterState:
        """导出为 Pydantic 状态模型快照。"""
        return ToolCounterState(
            calls_per_tool=dict(self._counts),
            total_calls=self._total_calls,
        )
