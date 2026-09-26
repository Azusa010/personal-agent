"""用户长期记忆提炼与纯追加写入引擎 (Memory Extractor)。

遵循《深入理解 AI Agent》第三章 Mem0 v3 核心范式：
- 单次提炼，仅做追加（ADD），绝不执行写入期 UPDATE/DELETE；
- 从任务轨迹的已确认事实 (DistilledFact) 与确认完成的动作中提取长期事实；
- 过滤临时性、瞬时细节（Ephemeral details）；
- 执行本地 PII 隐私脱敏，并生成带时间戳、消歧字段的 Advanced JSON Card；
- 计算稠密嵌入并写入 PostgreSQL。
"""

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import asyncpg

from personal_agent.conversation.compression.models import DistilledFact
from personal_agent.knowledge.embedder import BaseEmbedder
from personal_agent.knowledge.memory_repository import insert_user_memory
from personal_agent.knowledge.memory_sanitizer import sanitize_memory_data
from personal_agent.protocol.models import (
    MemoryCategory,
    MemoryType,
    UserMemoryCard,
    UserMemoryItem,
    UserMemoryNote,
)

logger = logging.getLogger(__name__)

DISTILL_MODEL_ENV = "OPENAI_DISTILL_MODEL"
DEFAULT_DISTILL_MODEL = "gpt-4o-mini"


def resolve_distill_model() -> str:
    """解析提炼所用模型：优先读 OPENAI_DISTILL_MODEL，未配置则降级读 OPENAI_MODEL。"""
    distill_model = os.environ.get(DISTILL_MODEL_ENV, "").strip()
    if distill_model:
        return distill_model
    openai_model = os.environ.get("OPENAI_MODEL", "").strip()
    if openai_model:
        return openai_model
    return DEFAULT_DISTILL_MODEL


def build_memory_distill_prompt(task_summary: str, history: str) -> str:
    """装配大模型用户长期记忆提炼与分级提示词。"""
    return f"""你是一个专业的用户长期记忆提炼引擎。你的目标是从任务总结与对话历史中，提炼出具备长期价值的事实，并严格按重要性分级。

    [任务目标与总结]
    {task_summary}

    [交互与对话历史]
    {history}

    [分级判别准则与字段规范]
    请将提炼出的每条记忆分类为以下两档之一：
    1. entryFormat: "card"（关键结构化记忆，用于强约束与高频偏好）
       - 适用场景：用户明确表达的习惯与偏好、绝对禁忌与过敏、法定身份与核心人际关系。
       - 字段规范：
         - "entryFormat": "card"
         - "memoryType": "semantic" | "episodic" | "procedural"
         - "category": "preference" | "identity" | "relationship" | "work" | "routine" | "general"
         - "subject": 核心主题（简明实体或概念）
         - "content": 结构化键值对详情，例如 {{"dietary": "素食", "allergies": ["花生"]}}
         - "backstory": 记忆来源上下文简述
    2. entryFormat: "note"（轻量自然语言记忆，用于任务备忘与经验沉淀）
       - 适用场景：偶发技术探讨、排查背景流水、工具与环境配置备忘。
       - 字段规范：
         - "entryFormat": "note"
         - "title": 简明标题
         - "noteText": 完整保真的自然语言描述段落
         - "tags": 相关领域标签数组

    [Few-shot 示例]
    输出必须为严格合法的 JSON 数组，示例如下：
    [
      {{
        "entryFormat": "card",
        "memoryType": "semantic",
        "category": "preference",
        "subject": "咖啡偏好",
        "content": {{"favorite": "美式", "sugar": false}},
        "backstory": "用户声明喝咖啡绝不加糖"
      }},
      {{
        "entryFormat": "note",
        "title": "Docker镜像构建技巧",
        "noteText": "在构建包含pgvector的镜像时，配置国内镜像源可避免网络超时。",
        "tags": ["docker", "postgres", "network"]
      }}
    ]

    [输出要求]
    仅输出纯粹合法的 JSON 数组，切勿添加任何额外的开场白、解释或总结。若无值得沉淀的事实则输出空数组 []。"""


def parse_and_validate_memory_items(
    raw_response: str,
    task_id: str | None = None,
) -> list[UserMemoryItem]:
    """解析大模型返回的原始字符串为经过校验与 PII 脱敏的 UserMemoryItem 列表。"""
    if not raw_response or not isinstance(raw_response, str):
        return []
    # 1. 容错剥离 Markdown 代码块与杂质文字，截取 JSON 数组
    text = raw_response.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if (
            len(lines) >= 2
            and lines[0].startswith("```")
            and lines[-1].startswith("```")
        ):
            text = "\n".join(lines[1:-1]).strip()
    start_idx = text.find("[")
    end_idx = text.rfind("]")
    if start_idx != -1 and end_idx != -1 and start_idx < end_idx:
        text = text[start_idx : end_idx + 1]
    try:
        data = json.loads(text)
    except Exception as err:  # noqa: BLE001
        logger.warning(f"[memory_extractor] 大模型输出非合法 JSON: {err}")
        return []
    if not isinstance(data, list):
        logger.warning("[memory_extractor] 大模型输出非 JSON 数组，已忽略")
        return []
    now_iso = datetime.now(UTC).isoformat()
    parsed_items: list[UserMemoryItem] = []
    # 2. 逐项分流与局部容错处理
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        entry_format = str(item.get("entryFormat") or "").strip().lower()
        if not entry_format:
            if "noteText" in item or "note_text" in item:
                entry_format = "note"
            elif "subject" in item:
                entry_format = "card"
            else:
                continue
        try:
            if entry_format == "card":
                sanitized_subject, subj_changed = sanitize_memory_data(
                    item.get("subject", "")
                )
                sanitized_content, cont_changed = sanitize_memory_data(
                    item.get("content") or {}
                )
                backstory = item.get("backstory")
                sanitized_backstory, back_changed = (
                    sanitize_memory_data(backstory) if backstory else (None, False)
                )
                is_sanitized = bool(
                    subj_changed
                    or cont_changed
                    or back_changed
                    or item.get("isSanitized", False)
                )
                card = UserMemoryCard(
                    id=str(item.get("id") or uuid4()),
                    entryFormat="card",
                    memoryType=item.get("memoryType") or "semantic",
                    category=item.get("category") or "preference",
                    subject=str(sanitized_subject),
                    person=item.get("person") or "本人",
                    relationship=item.get("relationship") or "本人",
                    content=sanitized_content
                    if isinstance(sanitized_content, dict)
                    else {"text": str(sanitized_content)},
                    backstory=sanitized_backstory
                    or (f"源自任务 {task_id}" if task_id else None),
                    sourceTaskId=item.get("sourceTaskId") or task_id,
                    confidence=float(item.get("confidence", 0.95)),
                    occurredAt=item.get("occurredAt") or now_iso,
                    validFrom=item.get("validFrom") or now_iso,
                    supersededBy=item.get("supersededBy"),
                    supersedeReason=item.get("supersedeReason"),
                    accessCount=int(item.get("accessCount", 0)),
                    lastAccessedAt=item.get("lastAccessedAt"),
                    isSanitized=is_sanitized,
                    createdAt=item.get("createdAt") or now_iso,
                    updatedAt=item.get("updatedAt") or now_iso,
                )
                parsed_items.append(card)
            elif entry_format == "note":
                raw_title = item.get("title") or item.get("subject") or "任务备忘"
                raw_text = item.get("noteText") or item.get("note_text") or ""
                if not raw_text.strip():
                    continue
                sanitized_title, title_changed = sanitize_memory_data(raw_title)
                sanitized_text, text_changed = sanitize_memory_data(raw_text)
                is_sanitized = bool(
                    title_changed or text_changed or item.get("isSanitized", False)
                )
                raw_tags = item.get("tags")
                tags = [str(t) for t in raw_tags] if isinstance(raw_tags, list) else []
                note = UserMemoryNote(
                    id=str(item.get("id") or uuid4()),
                    entryFormat="note",
                    title=str(sanitized_title),
                    noteText=str(sanitized_text),
                    tags=tags,
                    sourceTaskId=item.get("sourceTaskId") or task_id,
                    confidence=float(item.get("confidence", 0.8)),
                    occurredAt=item.get("occurredAt") or now_iso,
                    validFrom=item.get("validFrom") or now_iso,
                    accessCount=int(item.get("accessCount", 0)),
                    lastAccessedAt=item.get("lastAccessedAt"),
                    isSanitized=is_sanitized,
                    createdAt=item.get("createdAt") or now_iso,
                    updatedAt=item.get("updatedAt") or now_iso,
                )
                parsed_items.append(note)
        except Exception as item_err:  # noqa: BLE001
            logger.warning(
                f"[memory_extractor] 第 {idx + 1} 条记忆校验实例化失败，安全跳过: {item_err}"
            )
            continue
    return parsed_items


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


def is_transient_fact(fact: DistilledFact, client: Any | None = None) -> bool:
    """判定是否为瞬时执行细节，瞬时细节不沉淀为长期记忆。"""
    jev_client = client
    if jev_client is None:
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if api_key:
            try:
                from typesafe_sdk import TypeSafeClient

                jev_client = TypeSafeClient()
            except Exception as err:  # noqa: BLE001
                logger.warning(
                    "[memory_extractor] TypeSafeClient 实例化失败，降级为关键词规则: %s",
                    err,
                )
    if jev_client is not None:
        from typesafe_sdk import Choice

        try:
            response = jev_client.system_one(
                state={
                    "subject": fact.subject,
                    "predicate": fact.predicate,
                    "object": fact.object,
                },
                questions={
                    "is_transient": Choice(
                        instructions="请判断该事实是否为瞬时执行细节，若是则返回 True，否则返回 False。",
                        criteria={
                            "True": "该事实仅涉及临时路径、进程ID、缓存、退出码等瞬时执行细节。",
                            "False": "该事实具有长期价值，可沉淀为用户记忆。",
                        },
                    )
                },
            )
            is_transient = response.get("is_transient")
            if isinstance(is_transient, str):
                return is_transient.lower() == "true"
        except Exception as err:  # noqa: BLE001
            logger.warning(
                "[memory_extractor] TypeSafeClient 判定瞬时事实失败，降级为关键词规则: %s",
                err,
            )

    full_text = f"{fact.subject} {fact.predicate} {fact.object}".lower()
    for kw in TRANSIENT_KEYWORDS:
        if kw in full_text:
            return True
    return False


def infer_memory_classification(
    fact: DistilledFact,
) -> tuple[MemoryType, MemoryCategory]:
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
        for k in [
            "流程",
            "规范",
            "步骤",
            "先",
            "然后",
            "procedure",
            "rule",
            "guideline",
        ]
    ):
        return "procedural", "routine"

    if any(
        k in pred or k in subj
        for k in [
            "完成",
            "生成",
            "导出",
            "创建",
            "解决",
            "发生",
            "过期",
            "截止",
            "event",
        ]
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
    """用户记忆提炼与纯追加引擎（支持 DistilledFact 基础写入与 LLM 端到端提炼分级）。"""

    def __init__(
        self,
        pool: asyncpg.Pool,
        embedder: BaseEmbedder | None = None,
        model: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.pool = pool
        self.embedder = embedder
        self._model = model or resolve_distill_model()
        self._client = client

    def _get_client(self) -> Any | None:
        if self._client is not None:
            return self._client
        api_key = os.environ.get("OPENAI_DISTILL_API_KEY") or os.environ.get(
            "OPENAI_API_KEY"
        )
        if not api_key:
            return None
        base_url = os.environ.get("OPENAI_DISTILL_BASE_URL") or os.environ.get(
            "OPENAI_BASE_URL"
        )
        try:
            from openai import OpenAI

            if base_url:
                self._client = OpenAI(api_key=api_key, base_url=base_url)
            else:
                self._client = OpenAI(api_key=api_key)
            return self._client
        except Exception as err:  # noqa: BLE001
            logger.error(f"[memory_extractor] 初始化 OpenAI 客户端失败: {err}")
            return None

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

    async def distill_from_history(
        self,
        task_id: str,
        task_summary: str,
        history: str,
    ) -> list[UserMemoryItem]:
        """使用大模型从任务总结与对话历史中端到端提炼并分级记忆，经校验、脱敏与向量化后纯追加写入 PostgreSQL。"""
        client = self._get_client()
        if client is None:
            logger.warning(
                "[memory_extractor] 未配置 LLM 客户端，跳过对话历史长期记忆提炼"
            )
            return []

        prompt = build_memory_distill_prompt(task_summary, history)
        try:
            completion = client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )
            raw_response = completion.choices[0].message.content or ""
        except Exception as err:  # noqa: BLE001
            logger.error(f"[memory_extractor] LLM 记忆提炼调用失败: {err}")
            return []

        items = parse_and_validate_memory_items(raw_response, task_id=task_id)

        persisted_items: list[UserMemoryItem] = []
        for item in items:
            embedding: list[float] | None = None
            if self.embedder is not None:
                if (
                    isinstance(item, UserMemoryNote)
                    or getattr(item, "entryFormat", "card") == "note"
                ):
                    text_to_embed = (
                        f"{item.title} {item.noteText} {' '.join(item.tags)}"
                    )
                else:
                    text_to_embed = f"{item.subject} {item.category} {json.dumps(item.content, ensure_ascii=False)}"
                emb_res = await self.embedder.embed_query(text_to_embed)
                embedding = emb_res.dense

            await insert_user_memory(self.pool, item, embedding)
            persisted_items.append(item)

        logger.info(
            f"[memory_extractor] 任务 {task_id} LLM 记忆提炼完成: "
            f"提炼并持久化 {len(persisted_items)} 条分级记忆 (Cards & Notes)"
        )
        return persisted_items
