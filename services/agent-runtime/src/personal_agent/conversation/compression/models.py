"""上下文压缩与知识提炼的核心数据模型契约。"""

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class TaskType(str, Enum):
    """任务模式枚举：决定提炼时的侧重维度。"""

    RETRIEVAL = "retrieval"      # 检索型：广度优先、完备列表、路径引用
    ANALYTICAL = "analytical"    # 分析型：深度优先、因果链条、数据指标
    CREATIVE = "creative"        # 创作型：启发点优先、概念锚点、意象素材


class LifecycleTier(str, Enum):
    """信息生命周期分层。"""

    EPHEMERAL_L0 = "ephemeral_l0"      # 瞬时执行细节（命令输出/多余条目），确认后折叠
    TASK_SCOPED_L1 = "task_scoped_l1"  # 任务级核心事实（5W1H 事实），结构化常驻
    PERSISTENT_L2 = "persistent_l2"    # 长期记忆与跨会话持久化认知（预留至后续 Memory 记忆系统接入）


class DistilledFact(BaseModel):
    """结构化事实单元，恪守 5W1H 语义完整性。"""

    model_config = ConfigDict(extra="allow")

    subject: str = Field(min_length=1, description="事实主体 (Who / What)")
    predicate: str = Field(min_length=1, description="动作或状态谓词 (Action / Relation)")
    object: str = Field(default="", description="客体、受词或关联组织 (Where / Target)")
    temporal: str | None = Field(default=None, description="明确的时间锚点 (When)")
    conditions: str | None = Field(default=None, description="前置或伴随限定条件")
    pageRefs: list[int] = Field(default_factory=list, description="来源页码或位置索引")


class DistilledObservation(BaseModel):
    """提炼后的工具观察对象，捍卫工具调用配对不变量。"""

    model_config = ConfigDict(extra="allow")

    callId: str = Field(min_length=1, description="严格对应原始工具调用的 callId")
    capability: str = Field(min_length=1, description="调用的能力名称")
    ok: bool = Field(description="工具执行状态")
    tier: LifecycleTier = Field(description="该条观察所处的生命周期分层")
    summary: str = Field(description="高密度自然语言/结构化提炼摘要")
    facts: list[DistilledFact] = Field(default_factory=list, description="提取出的结构化事实清单")
    originalChars: int = Field(default=0, description="提炼前原始字符数")
    distilledChars: int = Field(default=0, description="提炼后字符数")

    @property
    def compression_ratio(self) -> float:
        """压缩率：1 - (压缩后字符数 / 原始字符数)。"""
        if self.originalChars <= 0:
            return 0.0
        ratio = 1.0 - (self.distilledChars / self.originalChars)
        return max(ratio, 0.0)


class ProgressDocumentState(BaseModel):
    """持久化工作文档状态，认知外化工作区。"""

    model_config = ConfigDict(extra="allow")

    taskGoal: str = Field(default="", description="任务总目标")
    taskType: TaskType = Field(default=TaskType.RETRIEVAL, description="任务模式")
    verifiedFacts: list[DistilledFact] = Field(
        default_factory=list, description="已确认的事实清单"
    )
    milestones: list[str] = Field(default_factory=list, description="执行里程碑列表")
    notes: list[str] = Field(default_factory=list, description="主动沉淀的洞察与笔记")

