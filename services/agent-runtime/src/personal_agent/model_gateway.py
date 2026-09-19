from collections.abc import Callable
from typing import Annotated, Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from personal_agent.protocol.models import PlanStepDto, ProfileDto, Turn


class Observation(BaseModel):
    """一次 host 工具调用的结果，engine 记下来喂回模型。

    ok 单独提成顶层布尔而不是留在 payload 里：模型对成功和失败的处置
    """

    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    ok: bool
    payload: dict[str, Any] = Field(default_factory=dict)


ThinkingSink = Callable[[str], None]


class ModelContext(BaseModel):
    """模型上下文"""

    taskGoal: str
    visibleCapabilities: list[str] = Field(default_factory=list)
    observations: list[Observation] = Field(default_factory=list)
    plan: list[PlanStepDto] = Field(default_factory=list)
    history: list[Turn] = Field(default_factory=list)
    profile: ProfileDto | None = None


class ToolCallDecision(BaseModel):
    """模型要求调用工具"""

    kind: Literal["tool_call"]
    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)
    thinking: str | None = None


class SummaryDecision(BaseModel):
    """模型给出的最终摘要。

    reply 是要说给用户的话（UI 上助手气泡的正文）；facts 是带页码引用的证据
    清单，计划里没有「提取 PDF」时允许为空。
    """

    kind: Literal["summary"]
    reply: str = Field(min_length=1)
    facts: list[dict[str, Any]] = Field(default_factory=list)
    thinking: str | None = None


ModelDecision = Annotated[
    ToolCallDecision | SummaryDecision, Field(discriminator="kind")
]


class ModelUsage(BaseModel):
    """一个任务里累计的模型用量结算。

    字段名会进 wire：engine 把它原样塞进 model_usage 事件的 payload，
    TS 侧 eval 的 ModelUsagePayload 逐字对齐这几个 key。改名要双端一起改，
    漂了不会报错，只会让成本统计静默变成 0。
    """

    model: str = Field(min_length=1)
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    calls: int = Field(ge=0)


class ModelCallFailed(Exception):
    """模型调用失败：网络、鉴权、结构化输出不合契约。

    engine 捕获它并把任务收成 failed（reason 带 MODEL_CALL_FAILED 前缀），
    而不是让它冒到 runtime 的兜底分支变成 RUNTIME_INTERNAL —— 前者能让人
    在任务记录里直接看出是模型这一侧的问题。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ScriptExhausted(Exception):
    def __init__(self, steps: int) -> None:
        super().__init__(f"ScriptedModel 脚本已用尽（共 {steps} 步）仍被要求决策")
        self.steps = steps


@runtime_checkable
class ModelGateway(Protocol):
    """模型抽象端口"""

    def decide(
        self, context: ModelContext, on_thinking: ThinkingSink | None = None
    ) -> ModelDecision:
        """给出下一步决策。给了 on_thinking 就边想边把摘要吐给它。"""


@runtime_checkable
class UsageReporting(Protocol):
    """会记账的模型网关。

    与 ModelGateway 分开两个端口：确定性替身（ScriptedModel）不需要记，
    真实适配器（LiveModel）才记。engine 收尾时 isinstance 问一次，
    没有这个能力的网关一条 model_usage 事件都不加，scripted 链路的事件流
    保持原样（Golden Path E2E 逐条钉着事件类型）。
    """

    def usage_snapshot(self) -> ModelUsage | None:
        pass
