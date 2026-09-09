from typing import Literal, Any, Annotated, Protocol, runtime_checkable

from pydantic import BaseModel, Field


class ModelContext(BaseModel):
    """模型上下文"""

    taskGoal: str
    visibleCapabilities: list[str] = Field(default_factory=list)


class ToolCallDecision(BaseModel):
    """模型要求调用工具"""

    kind: Literal["tool_call"]
    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class SummaryDecision(BaseModel):
    """模型给出的最终摘要"""

    kind: Literal["summary"]
    facts: list[dict[str, Any]] = Field(default_factory=list)


ModelDecision = Annotated[
    ToolCallDecision | SummaryDecision, Field(discriminator="kind")
]


class ScriptExhausted(Exception):
    def __init__(self, steps: int) -> None:
        super().__init__(f"ScriptedModel 脚本已用尽（共 {steps} 步）仍被要求决策")
        self.steps = steps

@runtime_checkable
class ModelGateway(Protocol):
    """模型抽象端口"""
    def decide(self,context:ModelContext)->ToolCallDecision:
        pass    