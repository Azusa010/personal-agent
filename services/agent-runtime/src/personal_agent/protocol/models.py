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


class RunTaskParams(BaseModel):
    taskId: str = Field(min_length=1)
    goal: str = Field(min_length=1)


class RunTaskEvent(BaseModel):
    type: str = Field(min_length=1)
    payload: Any
    occurredAt: str = Field(min_length=1, pattern=OCCURRED_AT_PATTERN)


class SummaryFact(BaseModel):
    text: str = Field(min_length=1)
    pageRefs: list[Annotated[int, Field(ge=1)]]


class RunTaskCompleted(BaseModel):
    status: Literal["completed"]
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


class PlanStepDto(BaseModel):
    """capability 缺失表示这一步不经工具，由模型自己产出。

    与 zod 侧的差别：这边 None 是合法值，但 Response.model_dump(exclude_none=True)
    会递归剔掉它，所以线上形状与 TS 的 optional 一致。zod 的 optional 收
    undefined 却不收 null，这个键一旦以 null 出现就两端判定相反。
    """

    description: str = Field(min_length=1)
    capability: CapabilityId | None = None


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
