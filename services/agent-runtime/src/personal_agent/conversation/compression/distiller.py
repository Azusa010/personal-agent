"""递归提炼器（ObservationDistiller）：上下文感知提示词装配与独立模型递归提炼。"""

import json
import logging
import os
from typing import Any

from pydantic import ValidationError

from personal_agent.conversation.compression.invariants import (
    validate_semantic_integrity,
)
from personal_agent.conversation.compression.models import (
    DistilledFact,
    DistilledObservation,
    LifecycleTier,
    TaskType,
)
from personal_agent.conversation.compression.strategy import classify_lifecycle
from personal_agent.conversation.model.gateway import Observation

DISTILL_MODEL_ENV = "OPENAI_DISTILL_MODEL"
DEFAULT_DISTILL_MODEL = "gpt-4o-mini"

log = logging.getLogger("personal_agent")


def resolve_distill_model() -> str:
    """解析提炼所用模型：优先读 OPENAI_DISTILL_MODEL，未配置则降级读 OPENAI_MODEL。"""
    distill_model = os.environ.get(DISTILL_MODEL_ENV, "").strip()
    if distill_model:
        return distill_model
    openai_model = os.environ.get("OPENAI_MODEL", "").strip()
    if openai_model:
        return openai_model
    return DEFAULT_DISTILL_MODEL


def build_context_aware_prompt(
    query: str,
    context: str,
    raw_content: str,
    task_type: TaskType = TaskType.RETRIEVAL,
) -> str:
    """装配上下文感知提炼提示词。
    显式注入 Given the search query 和 Current context，引导提炼模型针对性浓缩。
    """
    return f"""你是一个专业的上下文感知知识提炼引擎。你的目标是从原始工具观察结果中提炼出高密度、结构化且无冗余的知识。

Given the search query: {query}
Current context: {context}
Task Mode: {task_type.value}

[待提炼原始内容 / RAW CONTENT]
<raw_content>
{raw_content}
</raw_content>

[提炼准则]
1. 语义完整性（5W1H 无损）：切勿丢失时间锚点、机构名称、主体与核心指标。
2. 价值金字塔：决策核心与实体列表 > 支撑证据与页码引用 > 剔除格式噪声、冗余空行。
3. 请输出合法的 JSON 格式，包含:
   - "summary": 浓缩的自然语言摘要
   - "facts": [ {{"subject": "...", "predicate": "...", "object": "...", "temporal": "...", "pageRefs": [...]}} ]
"""


class ObservationDistiller:
    """观察提炼器：支持 L0 瞬时细节快速凭证化与 L1 深度知识的上下文感知提炼。"""

    def __init__(
        self,
        model: str | None = None,
        client: Any | None = None,
    ) -> None:
        self._model = model or resolve_distill_model()
        self._client = client

    def distill_observation(
        self,
        observation: Observation,
        query: str = "",
        context: str = "",
        task_type: TaskType = TaskType.RETRIEVAL,
    ) -> DistilledObservation:
        """对单条观察执行生命周期分流提炼。"""
        tier = classify_lifecycle(observation.capability)
        raw_chars = len(json.dumps(observation.payload, ensure_ascii=False))

        if tier == LifecycleTier.EPHEMERAL_L0:
            status_text = "ok" if observation.ok else "failed"
            summary = f"[{observation.capability}: {status_text}] {query}".strip()
            return DistilledObservation(
                callId=observation.callId,
                capability=observation.capability,
                ok=observation.ok,
                tier=tier,
                summary=summary,
                facts=[],
                originalChars=raw_chars,
                distilledChars=len(summary),
            )

        # L1 或其他深度提炼
        raw_content = json.dumps(observation.payload, ensure_ascii=False)
        prompt = build_context_aware_prompt(
            query=query,
            context=context,
            raw_content=raw_content,
            task_type=task_type,
        )

        summary = f"提取自 {observation.capability}"
        valid_facts: list[DistilledFact] = []

        if self._client is not None:
            try:
                res = self._client.chat.completions.create(
                    model=self._model,
                    messages=[{"role": "user", "content": prompt}],
                )
                choice = res.choices[0]
                content = choice.message.content or ""
                parsed = json.loads(content)
                if isinstance(parsed, dict):
                    summary = parsed.get("summary", summary)
                    raw_facts = parsed.get("facts", [])
                    for rf in raw_facts:
                        try:
                            fact = DistilledFact(**rf)
                            ok, _ = validate_semantic_integrity(fact)
                            if ok:
                                valid_facts.append(fact)
                        except (ValidationError, TypeError, ValueError) as err:
                            log.debug("忽略不合规事实: %s", err)
            except Exception as err:  # noqa: BLE001
                log.warning("提炼模型调用或解析失败，平滑降级: %s", err)

        distilled_chars = len(summary) + sum(
            len(f.subject) + len(f.predicate) + len(f.object) for f in valid_facts
        )
        if distilled_chars == 0:
            distilled_chars = len(summary)

        return DistilledObservation(
            callId=observation.callId,
            capability=observation.capability,
            ok=observation.ok,
            tier=LifecycleTier.TASK_SCOPED_L1,
            summary=summary,
            facts=valid_facts,
            originalChars=raw_chars,
            distilledChars=distilled_chars,
        )