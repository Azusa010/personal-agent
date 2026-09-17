from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

METHOD_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"


class JsonRpcError(BaseModel):
    code: str
    message: str
    data: Any | None = None


class Request(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


class Response(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: Any | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


class Notification(BaseModel):
    jsonrpc: Literal["2.0"]
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


# ---- PDF ----
class PdfEntry(BaseModel):
    name: str
    absolutePath: str
    modifiedAt: str
    sizeBytes: int = Field(ge=0)


class FilesystemListParams(BaseModel):
    rootId: Literal["downloads"]

class FilesystemListResult(BaseModel):
    entries: list[PdfEntry]


class FilesystemCreateDirParams(BaseModel):
    path: str = Field(min_length=1)


class FilesystemMoveParams(BaseModel):
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)


# ---- system.initialize 的载荷模型 ----
class ClientInfo(BaseModel):
    name: str
    version: str


class ServerInfo(BaseModel):
    name: str
    version: str


# ---- host.execute_tool：Python → TS 的反向 RPC ----
HOST_EXECUTE_TOOL = "host.execute_tool"
HOST_CALL_ID_PATTERN = r"^call-[0-9]+$"

CapabilityId = Literal[
    "filesystem.list",
    "document.extract_pdf",
    "filesystem.create_dir",
    "filesystem.move",
    "scheduler.create",
    "notification.send",
]


class HostExecuteToolParams(BaseModel):

    callId: str = Field(min_length=1)
    capability: CapabilityId
    arguments: dict[str, Any] = Field(default_factory=dict)

class HostExecuteToolResult(BaseModel):

    model_config = ConfigDict(extra="allow")

    ok: bool


class HostExecuteToolRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(pattern=HOST_CALL_ID_PATTERN)
    method: Literal["host.execute_tool"]
    params: HostExecuteToolParams


class HostExecuteToolResponse(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(pattern=HOST_CALL_ID_PATTERN)
    result: HostExecuteToolResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


class CapabilityFailure(BaseModel):
    ok: Literal[False]
    code: str
    reason: str

class PageText(BaseModel):
    pageNumber: int = Field(ge=1)
    text: str

class DocumentExtractPdfParams(BaseModel):
    path:str = Field(min_length=1)


class DocumentExtractPdfResult(BaseModel):
    ok: Literal[True]
    pages: list[PageText]

DocumentExtractPdfOutcome = Annotated[
    DocumentExtractPdfResult | CapabilityFailure, Field(discriminator="ok")
]


class FilesystemCreateDirResult(BaseModel):
    ok: Literal[True]
    path: str = Field(min_length=1)
    created: bool


FilesystemCreateDirOutcome = Annotated[
    FilesystemCreateDirResult | CapabilityFailure, Field(discriminator="ok")
]


class FilesystemMoveResult(BaseModel):
    ok: Literal[True]
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)


FilesystemMoveOutcome = Annotated[
    FilesystemMoveResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- scheduler.create（TASK-023）----
# Reminder 的四种状态，与 packages/protocol/schemas/scheduler.ts 的 ReminderStatus
# 及 reminders 表 CHECK 约束同源。scheduled=待触发；firing=触发中；fired=终态；
# failed=只允许显式重试。
ReminderStatus = Literal["scheduled", "firing", "fired", "failed"]


class SchedulerCreateParams(BaseModel):
    """remindAt 是模型把「今晚」解析后的具体时间（ISO-8601），message 是通知正文。

    契约层只钉形状；能否解析、是否在未来由 host 侧 binder 判定
    （REMINDER_TIME_IN_PAST），与 DocumentExtractPdfParams 不校验路径越界同理。
    """

    model_config = ConfigDict(extra="allow")

    remindAt: str = Field(min_length=1)
    message: str = Field(min_length=1)


class SchedulerCreateResult(BaseModel):
    """created 区分「本次新建」与「命中同任务已有 Reminder 的幂等返回」。

    remindAt 是 binder 规范化后的 UTC ISO（毫秒三位 + Z），与 reminders.remind_at、
    批准面板展示的时间是同一个串。
    """

    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    reminderId: str = Field(min_length=1)
    remindAt: str = Field(min_length=1)
    status: ReminderStatus
    created: bool


SchedulerCreateOutcome = Annotated[
    SchedulerCreateResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- notification.send（TASK-024）----
# 与 packages/protocol/schemas/notification.ts 逐字段镜像。
class NotificationSendParams(BaseModel):
    """仅由持久化 Reminder 触发（PRD 3.2）：参数只有 reminderId 引用。

    通知正文来自落库的 reminders.message，模型传不进自由文本。存在性、归属、
    可触发状态、是否到点由 host 侧执行体判定（REMINDER_NOT_FOUND /
    REMINDER_NOT_DUE），与 SchedulerCreateParams 不校验时间语义同理。
    """

    model_config = ConfigDict(extra="allow")

    reminderId: str = Field(min_length=1)


class NotificationSendResult(BaseModel):
    """sent 区分「本次真的发送了」与「幂等命中已 fired 的 Reminder」。

    sentAt 是翻到 fired 的时刻（reminders.fired_at）。status 在 ok:true 时
    只会是 fired——发送失败走 CapabilityFailure（NOTIFICATION_SEND_FAILED），
    不伪造成功（US-06）。
    """

    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    reminderId: str = Field(min_length=1)
    status: ReminderStatus
    sentAt: str = Field(min_length=1)
    sent: bool


NotificationSendOutcome = Annotated[
    NotificationSendResult | CapabilityFailure, Field(discriminator="ok")
]


CapabilityKind = Literal["READ", "WRITE"]


class CapabilityDescriptor(BaseModel):
    name: CapabilityId
    kind: CapabilityKind
    description: str = Field(min_length=1)


class InitializeResult(BaseModel):
    protocolVersion: Literal["0.1"]
    server: ServerInfo


class InitializeParams(BaseModel):
    protocolVersion: Literal["0.1"]  # 字段名直接用 JSON 里的 key，保持两端一致
    capabilities: list[CapabilityDescriptor]
    client: ClientInfo


# ---- agent.run_task：TS → Python 触发一个任务 ----
AGENT_RUN_TASK = "agent.run_task"
OCCURRED_AT_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"


class PlanStepDto(BaseModel):
    description: str = Field(min_length=1)
    capability: CapabilityId | None = None


class RunTaskParams(BaseModel):
    taskId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    plan: list[PlanStepDto] = Field(min_length=1)


class RunTaskEvent(BaseModel):
    type: str = Field(min_length=1)
    payload: Any
    occurredAt: str = Field(min_length=1, pattern=OCCURRED_AT_PATTERN)


class SummaryFact(BaseModel):
    text: str = Field(min_length=1)
    pageRefs: list[Annotated[int, Field(ge=1)]]


class RunTaskCompleted(BaseModel):
    status: Literal["completed"]
    # reply 是这一轮要说给用户的话：进 task_completed 事件与 completed 回包，
    # 是 UI 上助手气泡的正文。facts 是带页码引用的证据，零工具轮次允许为空。
    reply: str = Field(min_length=1)
    facts: list[SummaryFact]
    events: list[RunTaskEvent]


class RunTaskFailed(BaseModel):
    status: Literal["failed"]
    reason: str = Field(min_length=1)
    events: list[RunTaskEvent]


RunTaskResult = Annotated[
    RunTaskCompleted | RunTaskFailed, Field(discriminator="status")
]


class RunTaskRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: Literal["agent.run_task"]
    params: RunTaskParams


class RunTaskResponse(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: RunTaskResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


# ---- agent.make_plan：TS → Python 索要一份计划 ----
# 计划由 Python 产出（File Boundaries 第 140 行的 planning.py），但判定权在 Main：
# SEC-003 说 Main 是唯一 Permission Authority，所以计划回传后由 Main 持久化，
# 并作为 ActionAlignment 的比对基准。
AGENT_MAKE_PLAN = "agent.make_plan"


class MakePlanParams(BaseModel):
    taskId: str = Field(min_length=1)
    goal: str = Field(min_length=1)




class MakePlanResult(BaseModel):
    # 至少一步：空计划会让 Main 侧的 ActionAlignment 没有比对基准。
    steps: list[PlanStepDto] = Field(min_length=1)


class MakePlanRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: Literal["agent.make_plan"]
    params: MakePlanParams


class MakePlanResponse(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: MakePlanResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self
