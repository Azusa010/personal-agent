"""用户长期记忆提炼与纯追加写入引擎 (Memory Extractor)。

遵循《深入理解 AI Agent》第三章 Mem0 v3 核心范式：
- 单次提炼，仅做追加（ADD），绝不执行写入期 UPDATE/DELETE；
- 从任务轨迹的已确认事实 (DistilledFact) 与确认完成的动作中提取长期事实；
- 过滤临时性、瞬时细节（Ephemeral details）；
- 执行本地 PII 隐私脱敏，并生成带时间戳、消歧字段的 Advanced JSON Card；
- 计算稠密嵌入并写入 PostgreSQL。
"""

import logging
from datetime import UTC, datetime
from uuid import uuid4

import asyncpg

from personal_agent.conversation.compression.models import DistilledFact
from personal_agent.knowledge.embedder import BaseEmbedder
from personal_agent.knowledge.memory_repository import insert_user_memory
from personal_agent.knowledge.memory_sanitizer import sanitize_memory_data
from personal_agent.protocol.models import MemoryCategory, MemoryType, UserMemoryCard

logger = logging.getLogger(__name__)

# 瞬时或低价值事实排除关键词（如临时路径、进程ID等）
TRANSIENT_KEYWORDS = {
    "tmp",
    "temp",
    "cache",
    "stdout",
    "stderr",
    "pid",
    "临时",
    "缓存",
    "退出码",
    "exit code",
    "ping",
    "heartbeat",
    "连接成功",
}


def is_transient_fact(fact: DistilledFact) -> bool:
    """判定是否为瞬时执行细节，瞬时细节不沉淀为长期记忆。"""
    full_text = f"{fact.subject} {fact.predicate} {fact.object}".lower()
    for kw in TRANSIENT_KEYWORDS:
        if kw in full_text:
            return True
    return False


def infer_memory_classification(fact: DistilledFact) -> tuple[MemoryType, MemoryCategory]:
    """根据事实谓词与语义推导记忆类型与类别。"""
    pred = fact.predicate.lower()
    subj = fact.subject.lower()

    if any(k in pred or k in subj for k in ["偏好", "喜欢", "习惯", "prefer", "like"]):
        return "semantic", "preference"

    if any(
        k in pred or k in subj
        for k in ["身份", "姓名", "职业", "住址", "居住", "本人", "identity", "role"]
    ):
        return "semantic", "identity"

    if any(
        k in pred or k in subj
        for k in ["流程", "规范", "步骤", "先", "然后", "procedure", "rule", "guideline"]
    ):
        return "procedural", "routine"

    if any(
        k in pred or k in subj
        for k in ["完成", "生成", "导出", "创建", "解决", "发生", "过期", "截止", "event"]
    ):
        return "episodic", "general"

    return "semantic", "preference"


def extract_card_from_fact(
    fact: DistilledFact,
    task_id: str,
    task_summary: str | None = None,
) -> UserMemoryCard:
    """将单条 DistilledFact 转换为带消歧与时间属性的 UserMemoryCard，并执行 PII 脱敏。"""
    mem_type, category = infer_memory_classification(fact)

    raw_content = {
        "predicate": fact.predicate,
        "object": fact.object,
    }
    if fact.conditions:
        raw_content["conditions"] = fact.conditions
    if fact.pageRefs:
        raw_content["pageRefs"] = fact.pageRefs

    # 1. 执行本地 PII 脱敏
    sanitized_content, content_sanitized = sanitize_memory_data(raw_content)
    sanitized_subject, subject_sanitized = sanitize_memory_data(fact.subject)
    is_sanitized = content_sanitized or subject_sanitized

    # 2. 时间解析：优先取 temporal，兜底取当前 UTC 时间
    occurred_at: str | None = None
    if fact.temporal:
        occurred_at = fact.temporal

    now_iso = datetime.now(UTC).isoformat()
    backstory = f"源自任务 {task_id}"
    if task_summary:
        backstory += f": {task_summary}"

    return UserMemoryCard(
        id=str(uuid4()),
        memoryType=mem_type,
        category=category,
        subject=str(sanitized_subject),
        person="本人",
        relationship="本人",
        content=dict(sanitized_content),
        backstory=backstory,
        sourceTaskId=task_id,
        confidence=0.95,
        occurredAt=occurred_at or now_iso,
        validFrom=now_iso,
        supersededBy=None,
        supersedeReason=None,
        accessCount=0,
        lastAccessedAt=None,
        isSanitized=is_sanitized,
        createdAt=now_iso,
        updatedAt=now_iso,
    )


class MemoryExtractor:
    """用户记忆提炼与纯追加引擎。"""

    def __init__(
        self,
        pool: asyncpg.Pool,
        embedder: BaseEmbedder | None = None,
    ) -> None:
        self.pool = pool
        self.embedder = embedder

    async def distill_and_append(
        self,
        task_id: str,
        facts: list[DistilledFact],
        task_summary: str | None = None,
    ) -> list[UserMemoryCard]:
        """从事实清单中提炼长期记忆，并以纯追加 (Pure ADD) 方式写入 PostgreSQL。"""
        created_cards: list[UserMemoryCard] = []

        for fact in facts:
            # 1. 过滤瞬时细节
            if is_transient_fact(fact):
                logger.debug(
                    f"[memory_extractor] 过滤瞬时事实: {fact.subject} {fact.predicate}"
                )
                continue

            # 2. 转换为带消歧属性的 Card 并完成脱敏
            card = extract_card_from_fact(fact, task_id, task_summary)

            # 3. 计算稠密嵌入 (若提供了 embedder)
            embedding: list[float] | None = None
            if self.embedder is not None:
                text_to_embed = f"{card.subject} {fact.predicate} {fact.object}"
                emb_res = await self.embedder.embed_query(text_to_embed)
                embedding = emb_res.dense

            # 4. 纯追加写入数据库 (Mem0 v3: 绝不 UPDATE/DELETE)
            await insert_user_memory(self.pool, card, embedding)
            created_cards.append(card)

        logger.info(
            f"[memory_extractor] 任务 {task_id} 提炼完成: "
            f"输入 {len(facts)} 条事实，新增追加 {len(created_cards)} 条长期记忆"
        )
        return created_cards
