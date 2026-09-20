"""workflow/definition.py —— 确定性工作流的数据模型与规格定义。"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from personal_agent.protocol.models import CapabilityId, SummaryFact


@dataclass
class WorkflowState:
    """工作流执行上下文黑板。记录初始输入与各步骤的产物。"""

    inputs: dict[str, Any] = field(default_factory=dict)
    step_results: dict[str, Any] = field(default_factory=dict)

    def set_result(self, step_id: str, result: Any) -> None:
        self.step_results[step_id] = result

    def get_result(self, step_id: str, default: Any = None) -> Any:
        return self.step_results.get(step_id, default)


# 参数解析函数签名：接收当前工作流状态，产出传给 Host 端的 arguments 字典
ArgsResolver = Callable[[WorkflowState], dict[str, Any]]
# 摘要生成函数签名：接收工作流最终状态，产出 (reply_text, facts_list)
SummaryProducer = Callable[[WorkflowState], tuple[str, list[SummaryFact]]]


class WorkflowStep(BaseModel):
    """工作流中的一个确定性步骤。"""

    id: str = Field(min_length=1, description="步骤唯一标识")
    capability: CapabilityId = Field(description="调用的底层能力名")
    description: str = Field(min_length=1, description="步骤中文描述")
    # Pydantic 默认不校验可调用对象，ArbitraryTypes 允许 Callable 传入
    resolve_args: Callable[[WorkflowState], dict[str, Any]] = Field(
        description="从当前状态推导本步骤工具参数的解析器"
    )

    model_config = {"arbitrary_types_allowed": True}


class WorkflowDefinition(BaseModel):
    """一份完整的工作流编排蓝图。"""

    id: str = Field(min_length=1, description="工作流唯一标识，如 golden_path")
    name: str = Field(min_length=1, description="工作流显示名称")
    description: str = Field(default="", description="工作流功能说明")
    steps: Sequence[WorkflowStep] = Field(description="有序执行的步骤清单")
    produce_summary: SummaryProducer | None = Field(
        default=None,
        description="工作流全部步骤成功后的结果与摘要生成器",
    )

    model_config = {"arbitrary_types_allowed": True}