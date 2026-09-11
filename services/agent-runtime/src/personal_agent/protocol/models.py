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
    pageRefs: list[int] = Field(min_items=1)


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
