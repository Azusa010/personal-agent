from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

METHOD_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"


class ProtocolModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class JsonRpcError(ProtocolModel):
    code: str
    message: str
    data: Any | None = None


class Request(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


class Response(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: Any | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


class Notification(ProtocolModel):
    jsonrpc: Literal["2.0"]
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


# ---- PDF ----
class PdfEntry(ProtocolModel):
    name: str
    absolutePath: str
    modifiedAt: str
    sizeBytes: int = Field(ge=0)
    type: Literal["file", "directory"] = "file"


RootId = Literal["downloads", "workspace"]


class FilesystemListParams(ProtocolModel):
    rootId: RootId
    pattern: str | None = None


class FilesystemListResult(ProtocolModel):
    entries: list[PdfEntry]


class FilesystemCreateDirParams(ProtocolModel):
    path: str = Field(min_length=1)
    expected_parent_exists: bool | None = None


class FilesystemMoveParams(ProtocolModel):
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    expected_source_exists: bool | None = None
    expected_source_is_file: bool | None = None
    expected_target_dir_exists: bool | None = None


# ---- system.initialize 的载荷模型 ----
class ClientInfo(ProtocolModel):
    name: str
    version: str


class ServerInfo(ProtocolModel):
    name: str
    version: str


# ---- host.execute_tool：Python → TS 的反向 RPC ----
HOST_EXECUTE_TOOL = "host.execute_tool"
HOST_CALL_ID_PATTERN = r"^call-[0-9]+$"

CapabilityId = Literal[
    "filesystem_list",
    "document_extract_pdf",
    "read_document",
    "filesystem_create_dir",
    "filesystem_move",
    "scheduler_create",
    "notification_send",
    "terminal_execute",
    "knowledge_search",
    "user_memory_search",
    "viking_read_l0",
    "viking_read_l1",
    "viking_read_l2",
    "viking_write_l2",
    "code_interpreter",
    "file_search",
    "skill_search",
    "skill_read",
    "web_search",
    "file_read",
    "file_write",
    "file_edit",
]


class HostExecuteToolParams(ProtocolModel):
    callId: str = Field(min_length=1)
    capability: CapabilityId
    arguments: dict[str, Any] = Field(default_factory=dict)


class HostExecuteToolResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: bool


class HostExecuteToolRequest(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(pattern=HOST_CALL_ID_PATTERN)
    method: Literal["host.execute_tool"]
    params: HostExecuteToolParams


class HostExecuteToolResponse(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(pattern=HOST_CALL_ID_PATTERN)
    result: HostExecuteToolResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


class CapabilityFailure(ProtocolModel):
    ok: Literal[False]
    code: str
    reason: str


class PageText(ProtocolModel):
    pageNumber: int = Field(ge=1)
    text: str


class DocumentExtractPdfParams(ProtocolModel):
    path: str = Field(min_length=1)


class DocumentExtractPdfResult(ProtocolModel):
    ok: Literal[True]
    pages: list[PageText]


DocumentExtractPdfOutcome = Annotated[
    DocumentExtractPdfResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- read_document 统一文档读取规范 ----
DocumentFileType = Literal["auto", "pdf", "docx", "pptx", "xlsx", "text"]


class ReadDocumentParams(ProtocolModel):
    path: str = Field(min_length=1)
    fileType: DocumentFileType = "auto"
    pageStart: int = Field(default=1, ge=1)
    pageEnd: int | None = Field(default=None, ge=1)
    maxCharsPerPage: int = Field(default=4000, ge=1)


class DocumentPage(ProtocolModel):
    pageNumber: int = Field(ge=1)
    text: str
    truncated: bool = False


class ReadDocumentResult(ProtocolModel):
    ok: Literal[True]
    path: str | None = None
    totalPages: int = Field(ge=0)
    returnedPages: int = Field(ge=0)
    hasMore: bool
    nextPage: int | None = None
    pages: list[DocumentPage]


ReadDocumentOutcome = Annotated[
    ReadDocumentResult | CapabilityFailure, Field(discriminator="ok")
]


class FilesystemCreateDirResult(ProtocolModel):
    ok: Literal[True]
    path: str = Field(min_length=1)
    created: bool


FilesystemCreateDirOutcome = Annotated[
    FilesystemCreateDirResult | CapabilityFailure, Field(discriminator="ok")
]


class FilesystemMoveResult(ProtocolModel):
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


class SchedulerCreateParams(ProtocolModel):
    """remindAt 是模型把「今晚」解析后的具体时间（ISO-8601），message 是通知正文。

    契约层只钉形状；能否解析、是否在未来由 host 侧 binder 判定
    （REMINDER_TIME_IN_PAST），与 DocumentExtractPdfParams 不校验路径越界同理。
    """

    model_config = ConfigDict(extra="allow")

    remindAt: str = Field(min_length=1)
    message: str = Field(min_length=1)
    expected_no_duplicate: bool | None = None


class SchedulerCreateResult(ProtocolModel):
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
class NotificationSendParams(ProtocolModel):
    """仅由持久化 Reminder 触发（PRD 3.2）：参数只有 reminderId 引用。

    通知正文来自落库的 reminders.message，模型传不进自由文本。存在性、归属、
    可触发状态、是否到点由 host 侧执行体判定（REMINDER_NOT_FOUND /
    REMINDER_NOT_DUE），与 SchedulerCreateParams 不校验时间语义同理。
    """

    model_config = ConfigDict(extra="allow")

    reminderId: str = Field(min_length=1)


class NotificationSendResult(ProtocolModel):
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


# ---- terminal.execute ----
class TerminalExecuteParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    command: str = Field(min_length=1)
    cwd: str | None = None
    timeoutMs: int | None = Field(default=None, gt=0)
    expected_cwd_exists: bool | None = None


class TerminalExecuteResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    exitCode: int
    stdout: str
    stderr: str


TerminalExecuteOutcome = Annotated[
    TerminalExecuteResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- code_interpreter (Phase 4) ----
class CodeInterpreterParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    code: str = Field(min_length=1, description="待执行的 Python 代码")
    timeoutMs: int = Field(default=30000, gt=0, description="超时毫秒数，默认 30s")
    saveArtifacts: bool = Field(default=False, description="是否持久化产生的图表或文件")


class CodeInterpreterResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    exitCode: int
    stdout: str
    stderr: str
    artifacts: list[str] = Field(default_factory=list)
    truncated: bool | None = None


CodeInterpreterOutcome = Annotated[
    CodeInterpreterResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- file_search (Phase 4) ----
FileSearchMode = Literal["filename", "content_plain", "content_regex"]


class FileSearchParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    pattern: str = Field(min_length=1, description="检索模式（通配符或文本）")
    searchMode: FileSearchMode = Field(default="filename", description="搜索模式")
    relativeRoot: str | None = Field(default=None, description="搜索子路径，默认根目录")
    maxMatches: int = Field(default=50, gt=0, description="最多匹配结果数")


class FileSearchMatch(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    path: str
    lineNumber: int | None = None
    lineContent: str | None = None
    matchPreview: str | None = None


class FileSearchResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    totalMatches: int
    truncated: bool
    matches: list[FileSearchMatch]


FileSearchOutcome = Annotated[
    FileSearchResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- skill_search & skill_read (Phase 5) ----
class SkillMetadata(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    path: str | None = None


class SkillSearchParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    query: str = Field(min_length=1, description="搜索关键词或 '*'（名称或描述）")
    tag: str | None = Field(default=None, description="按标签过滤")
    maxResults: int = Field(default=20, gt=0, description="最多返回数量")


class SkillSearchResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    total: int = Field(ge=0)
    skills: list[SkillMetadata]


SkillSearchOutcome = Annotated[
    SkillSearchResult | CapabilityFailure, Field(discriminator="ok")
]


class SkillReadParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1, description="待加载指令的 Skill 唯一名称")


class SkillReadResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    name: str
    description: str
    tags: list[str] = Field(default_factory=list)
    content: str
    path: str


SkillReadOutcome = Annotated[
    SkillReadResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- web_search (Tavily) ----
class WebSearchParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    query: str = Field(min_length=1, description="搜索关键词或问题")
    maxResults: int = Field(default=5, ge=1, le=20, description="最多返回结果数")
    searchDepth: Literal["basic", "advanced"] = Field(
        default="basic", description="搜索深度"
    )
    includeAnswer: bool = Field(
        default=False, description="是否包含直接答案"
    )


class WebSearchResultItem(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    title: str
    url: str
    content: str
    score: float | None = None
    publishedDate: str | None = None


class WebSearchResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True] = True
    query: str
    results: list[WebSearchResultItem]
    answer: str | None = None


WebSearchOutcome = Annotated[
    WebSearchResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- file_read ----
class FileReadParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    path: str = Field(min_length=1, description="目标文件相对路径")
    startLine: int | None = Field(
        default=None, gt=0, description="起始行号（从 1 开始，包含）"
    )
    endLine: int | None = Field(default=None, gt=0, description="结束行号（包含）")


class FileReadResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    path: str = Field(min_length=1)
    content: str
    totalLines: int = Field(ge=0)
    startLine: int | None = Field(default=None, gt=0)
    endLine: int | None = Field(default=None, gt=0)


FileReadOutcome = Annotated[
    FileReadResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- file_write ----
class FileWriteParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    path: str = Field(min_length=1, description="目标文件相对路径")
    content: str = Field(description="写入的文件内容")
    expected_file_exists: bool | None = None


class FileWriteResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    path: str = Field(min_length=1)
    bytesWritten: int = Field(ge=0)
    diagnostics: list[str] | None = None


FileWriteOutcome = Annotated[
    FileWriteResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- file_edit ----
class FileEditParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    path: str = Field(min_length=1, description="目标文件相对路径")
    oldString: str = Field(
        min_length=1, description="待替换的原文本，必须在文件中全局唯一"
    )
    newString: str = Field(description="替换后的新文本")
    expected_file_line_count: int | None = Field(default=None, gt=0)
    expected_old_string_line: int | None = Field(default=None, gt=0)


class FileEditResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    path: str = Field(min_length=1)
    replacements: int = Field(default=1, gt=0)
    diagnostics: list[str] | None = None


FileEditOutcome = Annotated[
    FileEditResult | CapabilityFailure, Field(discriminator="ok")
]



# ---- knowledge.search (Phase 3) ----
class KnowledgeSearchParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    query: str = Field(min_length=1)
    topK: int = Field(default=5, ge=1, le=50)
    denseLimit: int | None = Field(default=None, ge=1, le=100)
    sparseLimit: int | None = Field(default=None, ge=1, le=100)
    fileTypes: list[str] | None = None
    documentIds: list[str] | None = None
    minScore: float | None = None


class KnowledgeChunkItem(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1)
    documentId: str = Field(min_length=1)
    fileName: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    chunkIndex: int = Field(ge=0)
    pageNumbers: list[int] = Field(default_factory=list)
    headingPath: str | None = None
    contextPrefix: str | None = None
    rawText: str
    score: float
    denseRank: int | None = Field(default=None, ge=1)
    sparseRank: int | None = Field(default=None, ge=1)


class KnowledgeSearchResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    query: str
    totalFound: int = Field(ge=0)
    chunks: list[KnowledgeChunkItem]


KnowledgeSearchOutcome = Annotated[
    KnowledgeSearchResult | CapabilityFailure, Field(discriminator="ok")
]


# ---- user_memory (Phase 5) ----
MemoryEntryFormat = Literal["card", "note"]
MemoryType = Literal["semantic", "episodic", "procedural"]
MemoryCategory = Literal[
    "preference",
    "identity",
    "relationship",
    "work",
    "routine",
    "general",
]


class UserMemoryCard(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    entryFormat: Literal["card"] = "card"
    id: str = Field(min_length=1)
    memoryType: MemoryType
    category: MemoryCategory
    subject: str = Field(min_length=1)
    person: str | None = None
    relationship: str | None = None
    content: dict[str, Any] = Field(default_factory=dict)
    backstory: str | None = None
    sourceTaskId: str | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    occurredAt: str | None = None
    validFrom: str
    supersededBy: str | None = None
    supersedeReason: str | None = None
    accessCount: int = Field(default=0, ge=0)
    lastAccessedAt: str | None = None
    isSanitized: bool = False
    createdAt: str
    updatedAt: str


class UserMemoryNote(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    entryFormat: Literal["note"] = "note"
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    noteText: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    sourceTaskId: str | None = None
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    occurredAt: str | None = None
    validFrom: str
    accessCount: int = Field(default=0, ge=0)
    lastAccessedAt: str | None = None
    isSanitized: bool = False
    createdAt: str
    updatedAt: str


UserMemoryItem = Annotated[
    UserMemoryCard | UserMemoryNote, Field(discriminator="entryFormat")
]


class UserMemorySearchParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    query: str = Field(min_length=1)
    entryFormat: MemoryEntryFormat | None = None
    memoryType: MemoryType | None = None
    category: MemoryCategory | None = None
    subject: str | None = None
    person: str | None = None
    relationship: str | None = None
    occurredAfter: str | None = None
    occurredBefore: str | None = None
    topK: int = Field(default=5, ge=1, le=50)
    includeSuperseded: bool = False
    minScore: float | None = None


class UserMemorySearchItem(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    card: UserMemoryCard | None = None
    note: UserMemoryNote | None = None
    item: UserMemoryItem | None = None
    score: float
    denseRank: int | None = Field(default=None, ge=1)
    sparseRank: int | None = Field(default=None, ge=1)
    matchedText: str


class UserMemorySearchResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True]
    query: str
    totalFound: int = Field(ge=0)
    items: list[UserMemorySearchItem]


UserMemorySearchOutcome = Annotated[
    UserMemorySearchResult | CapabilityFailure, Field(discriminator="ok")
]


CapabilityKind = Literal["READ", "WRITE"]
CapabilityExposure = Literal["direct", "deferred", "internal"]


class CapabilityDescriptor(ProtocolModel):
    name: CapabilityId
    kind: CapabilityKind
    description: str = Field(min_length=1)
    exposure: CapabilityExposure = "direct"


class InitializeResult(ProtocolModel):
    protocolVersion: Literal["0.1"]
    server: ServerInfo


class InitializeParams(ProtocolModel):
    protocolVersion: Literal["0.1"]  # 字段名直接用 JSON 里的 key，保持两端一致
    capabilities: list[CapabilityDescriptor]
    client: ClientInfo


# ---- agent.run_task：TS → Python 触发一个任务 ----
AGENT_RUN_TASK = "agent.run_task"
OCCURRED_AT_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"


class PlanStepDto(ProtocolModel):
    description: str = Field(min_length=1)
    capability: CapabilityId | None = None


class RunTaskEvent(ProtocolModel):
    type: str = Field(min_length=1)
    payload: Any
    occurredAt: str = Field(min_length=1, pattern=OCCURRED_AT_PATTERN)


class SummaryFact(ProtocolModel):
    text: str = Field(min_length=1)
    pageRefs: list[Annotated[int, Field(ge=1)]]


class RunTaskCompleted(ProtocolModel):
    status: Literal["completed"]
    # reply 是这一轮要说给用户的话：进 task_completed 事件与 completed 回包，
    # 是 UI 上助手气泡的正文。facts 是带页码引用的证据，零工具轮次允许为空。
    reply: str = Field(min_length=1)
    facts: list[SummaryFact]
    events: list[RunTaskEvent]


class RunTaskFailed(ProtocolModel):
    status: Literal["failed"]
    reason: str = Field(min_length=1)
    events: list[RunTaskEvent]


RunTaskResult = Annotated[
    RunTaskCompleted | RunTaskFailed, Field(discriminator="status")
]


class RunTaskResponse(ProtocolModel):
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


class Turn(ProtocolModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1)


class ProfileDto(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1, max_length=40)
    persona: str = Field(default="", max_length=2000)
    reasoningSummary: bool | None = None


class MakePlanParams(ProtocolModel):
    taskId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    history: list[Turn] = Field(default_factory=list)
    profile: ProfileDto | None = None


class RunTaskParams(ProtocolModel):
    taskId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    plan: list[PlanStepDto] = Field(min_length=1)
    history: list[Turn] = Field(default_factory=list)
    profile: ProfileDto | None = None


class RunTaskRequest(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: Literal["agent.run_task"]
    params: RunTaskParams


class MakePlanResult(ProtocolModel):
    # 至少一步：空计划会让 Main 侧的 ActionAlignment 没有比对基准。
    steps: list[PlanStepDto] = Field(min_length=1)


class MakePlanRequest(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: Literal["agent.make_plan"]
    params: MakePlanParams


class MakePlanResponse(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: MakePlanResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


# ---- agent.stream：TS → Python 触发一个事件 ----
AGENT_STREAM = "agent.stream"


class AgentStreamEvent(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["event"]
    taskId: str = Field(min_length=1)
    event: RunTaskEvent


class AgentStreamThinking(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["thinking"]
    taskId: str = Field(min_length=1)
    delta: str = Field(min_length=1)


AgentStreamParams = Annotated[
    AgentStreamEvent | AgentStreamThinking, Field(discriminator="kind")
]


class AgentStreamNotification(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    jsonrpc: Literal["2.0"]
    method: Literal["agent.stream"]
    params: AgentStreamParams


# ---- agent.run_workflow：TS → Python 触发一个确定性工作流 ----
AGENT_RUN_WORKFLOW = "agent.run_workflow"


class RunWorkflowParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    taskId: str = Field(min_length=1)
    workflowId: str = Field(min_length=1)
    inputs: dict[str, Any] = Field(default_factory=dict)


class RunWorkflowRequest(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: Literal["agent.run_workflow"]
    params: RunWorkflowParams


class RunWorkflowResponse(ProtocolModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: RunTaskResult | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


# ---- OpenViking Wiki Storage (Phase 5) ----
class VikingReadL0Params(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    uri: str = Field(min_length=1)


class VikingReadL0Result(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    ok: Literal[True] = True
    uri: str
    abstractText: str
    isValid: bool


class VikingReadL1Params(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    uri: str = Field(min_length=1)


class VikingReadL1Result(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    ok: Literal[True] = True
    uri: str
    overviewText: str


class VikingReadL2Params(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    uri: str = Field(min_length=1)


class VikingReadL2Result(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    ok: Literal[True] = True
    uri: str
    content: str


class VikingWriteL2Params(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    uri: str = Field(min_length=1)
    content: str
    expected_article_exists: bool | None = None


class VikingWriteL2Result(ProtocolModel):
    model_config = ConfigDict(extra="allow")
    ok: Literal[True] = True
    uri: str
    bytesWritten: int = Field(ge=0)


# ---- Knowledge Update & PR (Phase 6) ----

KnowledgeDiffOpType = Literal["ADD", "UPDATE", "INVALIDATE", "QUALIFY"]
KnowledgeTargetType = Literal["user_memory", "document_chunk", "viking_wiki"]
KnowledgePrStatus = Literal["pending", "approved", "rejected", "revision_requested"]
ReviewVerdict = Literal["approved", "rejected", "revision_requested"]
CritiqueVerdict = Literal["pass", "reject", "revise"]
CritiqueIssueType = Literal[
    "lacks_evidence", "over_broad_deletion", "missing_qualification", "format_error"
]


class KnowledgeDiffOp(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    op: KnowledgeDiffOpType
    targetType: KnowledgeTargetType
    targetId: UUID | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    evidenceRefs: list[UUID] = Field(min_length=1)
    qualification: str | None = None


class KnowledgeProposal(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    id: UUID
    title: str = Field(min_length=1)
    targetLayer: KnowledgeTargetType
    proposerModel: str = Field(min_length=1)
    operations: list[KnowledgeDiffOp] = Field(min_length=1)
    evidenceIds: list[UUID] = Field(min_length=1)
    status: KnowledgePrStatus = "pending"
    iterationCount: int = Field(default=1, ge=1)
    createdAt: str
    updatedAt: str


class KnowledgeReviewCritique(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    opIndex: int = Field(ge=0)
    verdict: CritiqueVerdict
    issueType: CritiqueIssueType | None = None
    explanation: str = Field(min_length=1)
    requiredCorrection: str | None = None
    evidenceRef: UUID | None = None


class KnowledgeReviewOutcome(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    proposalId: UUID
    reviewerModel: str = Field(min_length=1)
    verdict: ReviewVerdict
    critiques: list[KnowledgeReviewCritique] = Field(default_factory=list)
    reviewComments: str
    reviewedAt: str


# ---- Sidecar Safety & Context Engine (Phase 1) ----

SidecarVerdict = Literal["ALLOW", "REJECT_WITH_FEEDBACK", "ESCALATE_TO_USER"]
SidecarRiskCategory = Literal[
    "NONE",
    "DESTRUCTIVE_COMMAND",
    "CREDENTIAL_EXFILTRATION",
    "PROMPT_INJECTION",
    "SCOPE_ESCAPING",
    "SYSTEM_RESOURCE_ABUSE",
]
CircuitBreakerState = Literal["CLOSED", "OPEN", "HALF_OPEN"]


class SidecarAssessment(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    verdict: SidecarVerdict
    riskCategory: SidecarRiskCategory = "NONE"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    reason: str = Field(min_length=1)
    remediation: str | None = None
    assessedBy: str = Field(min_length=1)
    occurredAt: str


class CircuitBreakerRejectionRecord(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    riskCategory: SidecarRiskCategory | None = None


class CircuitBreakerEvent(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    taskId: str = Field(min_length=1)
    state: CircuitBreakerState
    consecutiveRejections: int = Field(ge=0)
    triggerReason: str = Field(min_length=1)
    recentRejections: list[CircuitBreakerRejectionRecord] = Field(default_factory=list)
    occurredAt: str


class SidecarCompactedObservation(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    callId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    originalChars: int = Field(ge=0)
    compactedChars: int = Field(ge=0)
    summary: str = Field(min_length=1)
    keyFacts: list[str] = Field(default_factory=list)
    rawArtifactRef: str | None = None


AGENT_RESET_CIRCUIT_BREAKER = "agent.reset_circuit_breaker"


class ResetCircuitBreakerParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    taskId: str = Field(min_length=1)
    reason: str | None = None


class ResetCircuitBreakerResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: bool
    state: CircuitBreakerState
    message: str


class ResetCircuitBreakerRequest(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    jsonrpc: Literal["2.0"] = "2.0"
    id: str = Field(min_length=1)
    method: Literal["agent.reset_circuit_breaker"] = AGENT_RESET_CIRCUIT_BREAKER
    params: ResetCircuitBreakerParams


class ResetCircuitBreakerResponse(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    jsonrpc: Literal["2.0"] = "2.0"
    id: str = Field(min_length=1)
    result: ResetCircuitBreakerResult | None = None
    error: JsonRpcError | None = None


# ---- A2UI Declarative UI Protocol (TASK-D1) ----

A2UIComponentType = Literal[
    "text_input",
    "textarea",
    "number_input",
    "select",
    "multi_select",
    "checkbox",
    "radio_group",
    "date_picker",
    "file_picker",
    "slider",
    "heading",
    "paragraph",
    "code_block",
    "table",
    "chart",
    "image",
    "divider",
    "alert",
    "form",
    "card",
    "tabs",
    "grid",
    "accordion",
]

A2UIActionType = Literal["submit", "cancel", "navigate"]


class A2UIAction(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    type: A2UIActionType
    variant: str | None = None
    target: str | None = None


class A2UIComponent(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    type: A2UIComponentType
    id: str = Field(min_length=1)
    props: dict[str, Any] = Field(default_factory=dict)
    children: list["A2UIComponent"] | None = None


class A2UIDocument(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    version: Literal["1.0"] = "1.0"
    title: str | None = None
    components: list[A2UIComponent] = Field(default_factory=list)
    actions: list[A2UIAction] | None = None


class A2UIRenderParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    document: A2UIDocument | None = None
    version: Literal["1.0"] = "1.0"
    title: str | None = None
    components: list[A2UIComponent] | None = None
    actions: list[A2UIAction] | None = None


class A2UIRenderResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True] = True
    renderId: str = Field(min_length=1)
    componentCount: int = Field(ge=0)
    actionId: str | None = None
    formData: dict[str, Any] | None = None


class A2UIFormSubmitParams(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    renderId: str | None = None
    actionId: str = Field(min_length=1)
    formData: dict[str, Any] = Field(default_factory=dict)


class A2UIFormSubmitResult(ProtocolModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True] = True
    actionId: str = Field(min_length=1)
    formData: dict[str, Any] = Field(default_factory=dict)
    accepted: bool = True


A2UIComponent.model_rebuild()
A2UIDocument.model_rebuild()
A2UIRenderParams.model_rebuild()

