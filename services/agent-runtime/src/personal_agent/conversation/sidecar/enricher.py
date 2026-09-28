"""Sidecar 上下文增强器 (Context Enricher & Compactor)。

负责：
1. 记忆预选与打分 (Memory Pre-filtering)：利用 Jev 极速打分过滤噪音，保留 Top-K 黄金事实
2. 超长工具输出动态压缩与本地持久化 (Observation Compactor)：
   输出超过门槛时，将原始输出写入本地临时文件，由 Sidecar LLM 浓缩为关键结论，
   并保留 raw_output_path 让主 Agent 明确知晓可按需深挖，同时在执行轨迹中完整保留。
"""

import asyncio
import concurrent.futures
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from personal_agent.conversation.model.gateway import Observation
from personal_agent.conversation.sidecar.llm_client import SidecarLlmClient
from personal_agent.protocol.models import SidecarCompactedObservation

log = logging.getLogger("personal_agent.sidecar")

DEFAULT_COMPACT_CHAR_THRESHOLD = 6000
DEFAULT_MEMORY_RELEVANCE_THRESHOLD = 45.0
DEFAULT_MEMORY_TOP_K = 3


def extract_candidate_text(candidate: dict[str, Any] | str) -> str:
    """从候选记忆项中提取代表性文本。"""
    if isinstance(candidate, str):
        return candidate
    if candidate.get("content"):
        return str(candidate["content"])
    if candidate.get("text"):
        return str(candidate["text"])
    if candidate.get("noteText"):
        return str(candidate["noteText"])
    if "subject" in candidate and "predicate" in candidate and "object" in candidate:
        return f"{candidate.get('subject')} {candidate.get('predicate')} {candidate.get('object')}"
    return json.dumps(candidate, ensure_ascii=False)


def compute_heuristic_relevance(goal: str, candidate_text: str) -> float:
    """计算离线启发式相关度分数 (0~100)。
    基于目标词项在候选文本中的覆盖率。
    """
    goal_words = set(re.findall(r"\w+", goal.lower()))
    if not goal_words:
        return 0.0
    cand_lower = candidate_text.lower()
    matched = sum(1 for w in goal_words if w in cand_lower)
    overlap_ratio = matched / len(goal_words)
    return round(overlap_ratio * 100.0, 1)


def _resolve_jev_client(client: Any | None = None) -> Any | None:
    if client is not None:
        return client
    api_key = (
        os.environ.get("PERSONAL_AGENT_SIDECAR_JEV_API_KEY")
        or os.environ.get("TYPESAFE_API_KEY")
        or ""
    ).strip()
    if not api_key:
        return None
    base_url = (
        os.environ.get("PERSONAL_AGENT_SIDECAR_JEV_BASE_URL")
        or os.environ.get("TYPESAFE_BASE_URL")
        or None
    )
    model = (
        os.environ.get("PERSONAL_AGENT_SIDECAR_JEV_MODEL")
        or os.environ.get("TYPESAFE_DEFAULT_MODEL")
        or None
    )
    kwargs: dict[str, Any] = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    if model:
        kwargs["model"] = model
    try:
        from typesafe_sdk import TypeSafeClient

        return TypeSafeClient(**kwargs)
    except Exception as err:  # noqa: BLE001
        log.warning("Sidecar Enricher TypeSafeClient 实例化失败: %s", err)
        return None


def filter_relevant_memories(
    goal: str,
    candidates: list[dict[str, Any]],
    threshold: float = DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
    top_k: int = DEFAULT_MEMORY_TOP_K,
    client: Any | None = None,
) -> list[dict[str, Any]]:
    """利用 Jev 极速评估模型或启发式规则，对候选记忆进行目标相关度打分与精选。"""
    if not candidates:
        return []

    jev_client = _resolve_jev_client(client)
    scored_candidates: list[tuple[float, dict[str, Any]]] = []

    if jev_client is not None:
        try:
            from typesafe_sdk import Choice, Noul, Score

            questions = {}
            for i, cand in enumerate(candidates):
                cand_text = extract_candidate_text(cand)
                questions[f"rel_{i}"] = Noul(
                    instructions=f"候选记忆 '{cand_text}' 是否对达成任务目标 '{goal}' 具有直接指导作用、约束价值或必要背景支持？",
                    criteria={
                        "true": "与当前任务目标直接相关，或者属于当前任务执行必须遵循的偏好、规范与硬性约束",
                        "false": "与当前任务无关的日常琐事、闲聊或不相关的其他历史事实",
                    },
                )
                questions[f"imp_{i}"] = Score(
                    instructions=f"评估候选记忆 '{cand_text}' 对完成当前任务的重要性与影响力等级（1到5档）：",
                    criteria=[
                        "1 - 完全无关的噪音，引入会白白消耗上下文甚至干扰决策",
                        "2 - 极弱相关的琐碎背景，不直接影响当前任务的实现与推进",
                        "3 - 辅助性参考上下文，对理解业务周边逻辑有一定帮助",
                        "4 - 重要的指导性偏好或通用规范，直接影响技术选型与实现方式",
                        "5 - 必须严格遵守的核心硬性约束或技术红线，一旦违反则任务不合格",
                    ],
                )
                questions[f"role_{i}"] = Choice(
                    instructions=f"判断候选记忆 '{cand_text}' 在当前任务中的角色属性：",
                    criteria={
                        "constraint": "强约束与硬性规则（如技术选型限制、权限边界、代码红线）",
                        "preference": "风格习惯与个性化偏好（如编码风格、日志习惯、格式偏好）",
                        "context": "项目领域背景知识或业务逻辑说明",
                        "noise": "与当前任务无关的闲聊杂音或过期失效的信息",
                    },
                )
            resp = jev_client.system_one(
                state={"taskGoal": goal},
                questions=questions,
            )
            for i, cand in enumerate(candidates):
                rel_ans = resp.answers.get(f"rel_{i}")
                imp_ans = resp.answers.get(f"imp_{i}")
                role_ans = resp.answers.get(f"role_{i}")

                noul_val = getattr(rel_ans, "noul", 0.0) if rel_ans else 0.0
                score_val = getattr(imp_ans, "score", 0.0) if imp_ans else 0.0
                role_choice = str(getattr(role_ans, "choice", "noise")).strip().lower() if role_ans else "noise"

                if role_choice == "noise" or noul_val < 0.2:
                    score = 0.0
                else:
                    base_score = (score_val / 4.0) * 70.0
                    role_bonus = {
                        "constraint": 30.0,
                        "preference": 20.0,
                        "context": 15.0,
                    }.get(role_choice, 0.0)
                    score = round(base_score + role_bonus, 1)

                scored_candidates.append((score, cand))
        except Exception as err:  # noqa: BLE001
            log.warning("Jev 记忆打分调用异常，降级为启发式打分: %s", err)
            scored_candidates = []

    if not scored_candidates:
        # 降级走本地启发式评分
        for cand in candidates:
            cand_text = extract_candidate_text(cand)
            score = compute_heuristic_relevance(goal, cand_text)
            if score == 0.0 and isinstance(cand, dict) and cand.get("retriever_score"):
                score = round(float(cand["retriever_score"]) * 60.0, 1)
            scored_candidates.append((score, cand))
    scored_memories:list[tuple[float, dict]] = []
    for score, cand in scored_candidates:
        if score < threshold:
            continue
        scored_memories.append((score, cand))
    scored_memories.sort(key=lambda x: x[0], reverse=True)
    if len(scored_memories) == 0:
        return []
    return [cand for score, cand in scored_memories[:top_k]]


WORKING_MEMORY_HEADER = "[用户常驻工作记忆"
WORKING_MEMORY_FOOTER = "[常驻记忆结束]"


def enrich_working_memory_persona(
    persona: str,
    task_goal: str,
    threshold: float = DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
    top_k: int = DEFAULT_MEMORY_TOP_K,
    client: Any | None = None,
) -> str:
    """对 persona 中的常驻记忆块进行基于 task_goal 的 Jev 语义预选与降噪。

    若包含 '[用户常驻工作记忆' 与 '[常驻记忆结束]'，提取其中的候选记忆行，
    通过 filter_relevant_memories 筛选高分黄金条目，剔除无关噪音。
    若筛选后无相关记忆，则移除该记忆块以精简上下文。
    """
    if WORKING_MEMORY_HEADER not in persona or WORKING_MEMORY_FOOTER not in persona:
        return persona

    start_idx = persona.find(WORKING_MEMORY_HEADER)
    end_idx = persona.find(WORKING_MEMORY_FOOTER)
    if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
        return persona

    end_idx += len(WORKING_MEMORY_FOOTER)
    prefix = persona[:start_idx].rstrip()
    memory_block = persona[start_idx:end_idx]
    suffix = persona[end_idx:].lstrip()

    raw_lines = [
        line.strip()
        for line in memory_block.splitlines()
        if line.strip().startswith("- ")
    ]
    if not raw_lines:
        return persona

    filtered_lines = filter_relevant_memories(
        goal=task_goal,
        candidates=raw_lines,
        threshold=threshold,
        top_k=top_k,
        client=client,
    )

    if not filtered_lines:
        parts = [p for p in (prefix, suffix) if p]
        return "\n\n".join(parts)

    reconstructed_block = (
        "[用户常驻工作记忆 - 以下为针对当前任务预选的偏好与事实约束]\n"
        + "\n".join(f"{extract_candidate_text(item)}" for item in filtered_lines)
        + "\n[常驻记忆结束]"
    )

    parts = [p for p in (prefix, reconstructed_block, suffix) if p]
    return "\n\n".join(parts)


CATEGORY_TAG_MAP: dict[str, str] = {
    "identity": "身份画像",
    "preference": "个人偏好",
    "routine": "流程惯例",
    "event": "重要情景",
    "skill": "技能经验",
    "general": "通用事实",
    "relationship": "人际关系",
    "work": "工作背景",
}


def format_memory_entry(card: Any) -> str:
    """将单条 UserMemoryCard 或记忆字典格式化为易读的文本提示词条目。"""
    if isinstance(card, str):
        return card
    category = (
        getattr(card, "category", "")
        or (card.get("category", "") if isinstance(card, dict) else "")
        or "通用"
    )
    tag = CATEGORY_TAG_MAP.get(category, category)
    subject = (
        getattr(card, "subject", "")
        or (card.get("subject", "") if isinstance(card, dict) else "")
        or "未命名事实"
    )
    content = getattr(card, "content", None) or (
        card.get("content", "") if isinstance(card, dict) else ""
    )
    if isinstance(content, dict):
        content_str = ", ".join(f"{k}: {v}" for k, v in content.items())
    elif isinstance(content, str):
        content_str = content
    else:
        content_str = str(content)

    person = getattr(card, "person", None) or (
        card.get("person", None) if isinstance(card, dict) else None
    )
    person_suffix = f" (关联人: {person})" if person and person != "本人" else ""
    return f"[{tag}] {subject}: {content_str}{person_suffix}"


def enrich_query_memories(
    query: str,
    candidates: list[dict[str, Any]] | list[str] | None = None,
    retriever: Any | None = None,
    threshold: float = DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
    top_k: int = DEFAULT_MEMORY_TOP_K,
    client: Any | None = None,
) -> list[str]:
    """在用户发送 query 时拦截请求，通过 Sidecar 检索并显式调用 filter_relevant_memories 精选黄金记忆。

    处理链路：
    1. 候选收集：优先使用传入的 candidates；若未提供，则尝试调用 UserMemoryRetriever 从数据库混合召回。
    2. Sidecar 精选 (核心)：显式调用 filter_relevant_memories 进行多维评分与降噪，淘汰低于 threshold 的低分/闲聊条目。
    3. 格式化输出：将保留的高分黄金记忆转换为标准文本行返回，供注入 ModelContext.userMemories。
    """
    if not query or not query.strip():
        return []

    try:
        raw_candidates: list[dict[str, Any]] | list[str] = []
        if candidates is not None:
            raw_candidates = list(candidates)
        else:
            if retriever is None:
                import socket

                from personal_agent.db.postgres import get_postgres_config

                cfg = get_postgres_config()
                try:
                    with socket.create_connection(
                        (cfg["host"], cfg["port"]), timeout=0.05
                    ):
                        pass
                except OSError:
                    return []

            from personal_agent.knowledge.retriever import UserMemoryRetriever
            from personal_agent.protocol.models import UserMemorySearchParams

            mem_retriever = retriever or UserMemoryRetriever()
            # 召回阶段放宽 topK (如 10 条) 供 Sidecar 精选
            params = UserMemorySearchParams(query=query.strip(), topK=max(top_k * 3, 10))

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    res = executor.submit(
                        lambda: asyncio.run(mem_retriever.search(params))
                    ).result()
            else:
                res = asyncio.run(mem_retriever.search(params))

            if not res or not res.items:
                return []

            for item in res.items:
                if hasattr(item, "card") and item.card:
                    c = item.card
                    raw_candidates.append({
                        "id": getattr(c, "id", ""),
                        "category": getattr(c, "category", ""),
                        "subject": getattr(c, "subject", ""),
                        "content": format_memory_entry(c),
                        "retriever_score": getattr(item, "score", None),
                        "raw_card": c,
                    })
                elif hasattr(item, "matchedText") and item.matchedText:
                    raw_candidates.append(str(item.matchedText))

        if not raw_candidates:
            return []

        # 核心：必须调用 filter_relevant_memories 进行多维打分、降噪与 Top-K 截断
        filtered = filter_relevant_memories(
            goal=query.strip(),
            candidates=raw_candidates,
            threshold=threshold,
            top_k=top_k,
            client=client,
        )

        formatted: list[str] = []
        for item in filtered:
            if isinstance(item, str):
                formatted.append(item)
            elif isinstance(item, dict):
                if item.get("content"):
                    formatted.append(str(item["content"]))
                elif item.get("raw_card"):
                    formatted.append(format_memory_entry(item["raw_card"]))
                else:
                    formatted.append(format_memory_entry(item))
            else:
                formatted.append(format_memory_entry(item))

        return formatted
    except Exception as err:  # noqa: BLE001
        log.warning("Sidecar 记忆检索与精选异常，降级为空列表: %s", err)
        return []


intercept_query_memories = enrich_query_memories


def compact_and_persist_observation(
    observation: Observation,
    sidecar_llm: SidecarLlmClient | None = None,
    max_chars: int = DEFAULT_COMPACT_CHAR_THRESHOLD,
    temp_dir: str | Path | None = None,
) -> tuple[Observation, Path | None]:
    """对超长工具执行输出进行本地临时文件落盘，并生成结构化精炼 Observation。"""
    payload = observation.payload
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    base_dir = Path(temp_dir) if temp_dir else Path(tempfile.gettempdir()) / "personal_agent" / "tool_outputs"
    output_file = base_dir / f"call_{observation.callId}_raw.txt"
    if len(text) <= max_chars:
        return observation, None

    base_dir.mkdir(parents=True, exist_ok=True)
    output_file.write_text(text, encoding="utf-8")
    if sidecar_llm is not None:
        try:
            compacted = sidecar_llm.compact_observation(
                call_id=observation.callId,
                capability=observation.capability,
                payload=payload,
                max_chars=max_chars
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Sidecar LLM 压缩调用失败，使用兜底压缩: %s", err)
            compacted = SidecarCompactedObservation(
                callId=observation.callId,
                capability=observation.capability,
                originalChars=len(text),
                compactedChars=min(len(text), 150),
                summary=f"内容过长已截断: {text[:100]}...",
                keyFacts=[]
            )
    else:
        compacted = SidecarCompactedObservation(
            callId=observation.callId,
            capability=observation.capability,
            originalChars=len(text),
            compactedChars=min(len(text), 150),
            summary=f"内容过长已截断: {text[:100]}...",
            keyFacts=[]
        )

    # 构造新的 Observation
    new_payload = {
        "compacted": True,
        "summary": compacted.summary,
        "keyFacts": compacted.keyFacts,
        "originalChars": len(text),
        "compactedChars": compacted.compactedChars,
        "raw_output_path": str(output_file),
        "hint": f"关键结论已在 summary 中提炼，若非必要无需查阅原文件。若确需查阅细节，未压缩输出暂存于本地: {output_file}。"
    }

    new_observation = Observation(
        callId=observation.callId,
        capability=observation.capability,
        ok=observation.ok,
        arguments=observation.arguments,
        payload=new_payload
    )

    return new_observation, output_file
