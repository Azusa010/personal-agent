"""PostgreSQL 用户记忆底层数据仓储层。

负责 user_memories 表的 CRUD、版本链演进、HNSW 向量检索与中文全文检索。
严格遵循 AGENTS.md 规范与认知科学双层记忆设计。
"""

import json
import logging
import math
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from personal_agent.protocol.models import (
    UserMemoryCard,
    UserMemorySearchItem,
    UserMemorySearchParams,
)

logger = logging.getLogger(__name__)


class MemoryRepositoryError(Exception):
    """用户记忆仓储基类异常。"""


class MemoryNotFoundError(MemoryRepositoryError):
    """指定记忆记录不存在。"""


def clean_fts_query(query_text: str) -> str:
    """清洗全文检索查询文本，防止语法错误并保留核心词。"""
    cleaned = re.sub(r"[&|!():*<>\\]", " ", query_text)
    return " ".join(cleaned.split()) or " "


def _row_to_memory_card(row: dict[str, Any] | asyncpg.Record) -> UserMemoryCard:
    """将数据库行转换为 UserMemoryCard 领域模型。"""
    raw_content = row["content"]
    content_dict = json.loads(raw_content) if isinstance(raw_content, str) else dict(raw_content or {})

    def to_iso(val: Any) -> str | None:
        if val is None:
            return None
        if isinstance(val, datetime):
            return val.isoformat()
        return str(val)

    return UserMemoryCard(
        id=str(row["id"]),
        memoryType=row["memory_type"],
        category=row["category"],
        subject=row["subject"] or "",
        person=row.get("person"),
        relationship=row.get("relationship"),
        content=content_dict,
        backstory=row.get("backstory"),
        sourceTaskId=row.get("source_task_id"),
        confidence=float(row.get("confidence") if row.get("confidence") is not None else 1.0),
        occurredAt=to_iso(row.get("occurred_at")),
        validFrom=to_iso(row["valid_from"]) or datetime.now(UTC).isoformat(),
        supersededBy=str(row["superseded_by"]) if row.get("superseded_by") else None,
        supersedeReason=row.get("supersede_reason"),
        accessCount=int(row.get("access_count") or 0),
        lastAccessedAt=to_iso(row.get("last_accessed_at")),
        isSanitized=bool(row.get("is_sanitized", False)),
        createdAt=to_iso(row["created_at"]) or datetime.now(UTC).isoformat(),
        updatedAt=to_iso(row["updated_at"]) or datetime.now(UTC).isoformat(),
    )


async def insert_user_memory(
    pool: asyncpg.Pool,
    card: UserMemoryCard,
    dense_embedding: list[float] | None = None,
) -> UUID:
    """插入一条用户记忆记录。"""
    query = """
    INSERT INTO user_memories (
        id, memory_type, category, subject, person, relationship,
        content, backstory, source_task_id, confidence, occurred_at,
        valid_from, superseded_by, supersede_reason, access_count,
        last_accessed_at, is_sanitized, dense_embedding, created_at, updated_at
    )
    VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, $20
    )
    RETURNING id;
    """
    mem_id = UUID(card.id) if card.id else uuid4()
    superseded_by_uuid = UUID(card.supersededBy) if card.supersededBy else None
    occurred_at_dt = datetime.fromisoformat(card.occurredAt) if card.occurredAt else None
    valid_from_dt = datetime.fromisoformat(card.validFrom) if card.validFrom else datetime.now(UTC)
    last_accessed_at_dt = datetime.fromisoformat(card.lastAccessedAt) if card.lastAccessedAt else None
    created_at_dt = datetime.fromisoformat(card.createdAt) if card.createdAt else datetime.now(UTC)
    updated_at_dt = datetime.fromisoformat(card.updatedAt) if card.updatedAt else datetime.now(UTC)

    async with pool.acquire() as conn:
        res_id = await conn.fetchval(
            query,
            mem_id,
            card.memoryType,
            card.category,
            card.subject,
            card.person,
            card.relationship,
            json.dumps(card.content),
            card.backstory,
            card.sourceTaskId,
            card.confidence,
            occurred_at_dt,
            valid_from_dt,
            superseded_by_uuid,
            card.supersedeReason,
            card.accessCount,
            last_accessed_at_dt,
            card.isSanitized,
            dense_embedding,
            created_at_dt,
            updated_at_dt,
        )
        return UUID(str(res_id))


async def get_user_memory_by_id(
    pool: asyncpg.Pool,
    memory_id: UUID | str,
) -> UserMemoryCard | None:
    """根据 ID 查询单条用户记忆。"""
    mem_uuid = UUID(str(memory_id))
    query = "SELECT * FROM user_memories WHERE id = $1 LIMIT 1;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, mem_uuid)
        return _row_to_memory_card(row) if row else None


async def get_active_memories(
    pool: asyncpg.Pool,
    memory_type: str | None = None,
    category: str | None = None,
    limit: int = 30,
) -> list[UserMemoryCard]:
    """查询当前有效记忆（常驻层 L1 使用）。

    在 Mem0 v3 纯追加范式下，按主题与主体优先保留最新发生/创建的事实。
    排序：置信度最高、访问频次最多、最新发生/更新者优先。
    """
    conditions = ["superseded_by IS NULL"]
    params: list[Any] = []

    if memory_type:
        params.append(memory_type)
        conditions.append(f"memory_type = ${len(params)}")

    if category:
        params.append(category)
        conditions.append(f"category = ${len(params)}")

    params.append(limit)
    where_clause = " AND ".join(conditions)
    query = f"""
    SELECT * FROM user_memories
    WHERE {where_clause}
    ORDER BY confidence DESC, access_count DESC, COALESCE(occurred_at, created_at) DESC
    LIMIT ${len(params)};
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)
        return [_row_to_memory_card(r) for r in rows]


async def increment_access_stats(
    pool: asyncpg.Pool,
    memory_ids: list[UUID | str],
) -> int:
    """海马体强化效应：累加指定记忆的访问频次并刷新最后访问时间。"""
    if not memory_ids:
        return 0

    uuids = [UUID(str(m)) for m in memory_ids]
    now = datetime.now(UTC)
    query = """
    UPDATE user_memories
    SET access_count = access_count + 1,
        last_accessed_at = $2
    WHERE id = ANY($1::uuid[]);
    """
    async with pool.acquire() as conn:
        res = await conn.execute(query, uuids, now)
        try:
            return int(res.split(" ")[-1])
        except (IndexError, ValueError):
            return 0


async def search_memories_hybrid(
    pool: asyncpg.Pool,
    query_text: str,
    dense_vector: list[float] | None = None,
    params: UserMemorySearchParams | None = None,
    limit: int = 5,
) -> list[UserMemorySearchItem]:
    """用户记忆混合检索（检索层 L2 使用）。

    结合 pgvector 稠密语义检索 + pg_jieba 中文全文检索，融合多维元数据过滤（类别、实体、时间切片）。
    """
    p = params or UserMemorySearchParams(query=query_text, topK=limit)
    base_conditions: list[str] = []
    base_params: list[Any] = []

    if not p.includeSuperseded:
        base_conditions.append("m.superseded_by IS NULL")

    if p.memoryType:
        base_params.append(p.memoryType)
        base_conditions.append(f"m.memory_type = ${len(base_params)}")

    if p.category:
        base_params.append(p.category)
        base_conditions.append(f"m.category = ${len(base_params)}")

    if p.subject:
        base_params.append(f"%{p.subject}%")
        base_conditions.append(f"m.subject ILIKE ${len(base_params)}")

    if p.person:
        base_params.append(p.person)
        base_conditions.append(f"m.person = ${len(base_params)}")

    if p.relationship:
        base_params.append(p.relationship)
        base_conditions.append(f"m.relationship = ${len(base_params)}")

    if p.occurredAfter:
        base_params.append(datetime.fromisoformat(p.occurredAfter))
        base_conditions.append(f"m.occurred_at >= ${len(base_params)}")

    if p.occurredBefore:
        base_params.append(datetime.fromisoformat(p.occurredBefore))
        base_conditions.append(f"m.occurred_at <= ${len(base_params)}")

    async with pool.acquire() as conn:
        dense_results: dict[str, tuple[int, float, UserMemoryCard]] = {}
        if dense_vector is not None:
            dense_cond = list(base_conditions)
            dense_params = list(base_params)
            dense_params.append(dense_vector)
            dense_cond.append("m.dense_embedding IS NOT NULL")
            vec_idx = len(dense_params)
            dense_params.append(limit * 2)
            limit_idx = len(dense_params)

            where_str = f"WHERE {' AND '.join(dense_cond)}" if dense_cond else ""
            dense_sql = f"""
            SELECT m.*, (1 - (m.dense_embedding <=> ${vec_idx})) AS cosine_sim
            FROM user_memories m
            {where_str}
            ORDER BY m.dense_embedding <=> ${vec_idx} ASC
            LIMIT ${limit_idx};
            """
            dense_rows = await conn.fetch(dense_sql, *dense_params)
            for rank, r in enumerate(dense_rows, start=1):
                card = _row_to_memory_card(r)
                sim = float(r["cosine_sim"] or 0.0)
                dense_results[card.id] = (rank, sim, card)

        sparse_results: dict[str, tuple[int, float, UserMemoryCard]] = {}
        cleaned_q = clean_fts_query(p.query)
        if cleaned_q.strip():
            sparse_cond = list(base_conditions)
            sparse_params = list(base_params)
            sparse_params.append(cleaned_q)
            q_idx = len(sparse_params)
            sparse_cond.append(f"m.fts_vector @@ to_tsquery('jiebacfg', ${q_idx})")
            sparse_params.append(limit * 2)
            limit_idx = len(sparse_params)

            where_str = f"WHERE {' AND '.join(sparse_cond)}"
            sparse_sql = f"""
            SELECT m.*, ts_rank_cd(m.fts_vector, to_tsquery('jiebacfg', ${q_idx})) AS rank_score
            FROM user_memories m
            {where_str}
            ORDER BY rank_score DESC
            LIMIT ${limit_idx};
            """
            try:
                sparse_rows = await conn.fetch(sparse_sql, *sparse_params)
                for rank, r in enumerate(sparse_rows, start=1):
                    card = _row_to_memory_card(r)
                    score = float(r["rank_score"] or 0.0)
                    sparse_results[card.id] = (rank, score, card)
            except (asyncpg.PostgresError, ValueError) as e:
                logger.warning(f"[memory_repository] 全文检索语法异常 ({e})，降级依赖稠密结果")

        all_ids = set(dense_results.keys()) | set(sparse_results.keys())
        scored_items: list[UserMemorySearchItem] = []
        now = datetime.now(UTC)

        for mid in all_ids:
            dense_rank = dense_results[mid][0] if mid in dense_results else None
            sparse_rank = sparse_results[mid][0] if mid in sparse_results else None
            card = dense_results[mid][2] if mid in dense_results else sparse_results[mid][2]

            # 计算记忆距今的天数（优先采用 occurred_at，兜底使用 created_at）
            card_time_str = card.occurredAt or card.createdAt
            delta_days = 0.0
            if card_time_str:
                try:
                    card_dt = datetime.fromisoformat(card_time_str)
                    delta_days = max(0.0, (now - card_dt).total_seconds() / 86400.0)
                except (ValueError, TypeError):
                    delta_days = 0.0

            score = fuse_memory_scores(
                dense_rank=dense_rank,
                sparse_rank=sparse_rank,
                time_delta_days=delta_days,
                access_count=card.accessCount,
            )

            matched_text = f"{card.subject}: {json.dumps(card.content, ensure_ascii=False)}"
            if card.backstory:
                matched_text += f" | 来源: {card.backstory}"

            scored_items.append(
                UserMemorySearchItem(
                    card=card,
                    score=score,
                    denseRank=dense_rank,
                    sparseRank=sparse_rank,
                    matchedText=matched_text,
                )
            )

        # 排序：综合得分最高者优先；若得分相同，以最新时间优先
        scored_items.sort(
            key=lambda x: (
                x.score,
                x.card.occurredAt or x.card.createdAt,
            ),
            reverse=True,
        )
        return scored_items[:limit]


def fuse_memory_scores(
    dense_rank: int | None,
    sparse_rank: int | None,
    time_delta_days: float,
    access_count: int = 0,
    *,
    k: int = 60,
    half_life_days: float = 30.0,
    recency_weight: float = 0.05,
    freq_weight: float = 0.01,
) -> float:
    """计算单条记忆在混合检索中的多维融合得分。
    """
    rrf = 0.0
    if dense_rank is not None:
        rrf += 1.0 / (k + dense_rank)
    if sparse_rank is not None:
        rrf += 1.0 / (k + sparse_rank)

    decay = 0.5 ** (max(0.0, time_delta_days) / half_life_days)
    recency_score = recency_weight * decay
    freq_score = freq_weight * min(math.log1p(max(0, access_count)), 2.0)
    return round(rrf + recency_score + freq_score, 4)

