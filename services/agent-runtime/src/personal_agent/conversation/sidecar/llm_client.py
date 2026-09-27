"""Sidecar 独立语言模型 (LLM) 客户端。

负责：
1. 工具拦截时的自愈纠偏指引生成 (Remediation)
2. 超长工具观察结果的动态结构化压缩 (Observation Compaction)
"""

import json
import logging
import os
from typing import Any

from personal_agent.protocol.models import SidecarCompactedObservation

log = logging.getLogger("personal_agent.sidecar")

DEFAULT_SIDECAR_MODEL = "gpt-4o-mini"


class SidecarLlmClient:
    """Sidecar 独立语言模型轻量客户端。"""

    def __init__(self, client: Any | None = None, model: str | None = None) -> None:
        self._client = client
        self._model = (
            model
            or os.environ.get("PERSONAL_AGENT_SIDECAR_MODEL")
            or os.environ.get("OPENAI_MODEL")
            or DEFAULT_SIDECAR_MODEL
        )

    def _get_client(self) -> Any | None:
        if self._client is not None:
            return self._client
        api_key = (
            os.environ.get("PERSONAL_AGENT_SIDECAR_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ""
        ).strip()
        if not api_key:
            return None
        base_url = (
            os.environ.get("PERSONAL_AGENT_SIDECAR_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or None
        )
        try:
            from openai import OpenAI

            self._client = OpenAI(api_key=api_key, base_url=base_url)
            return self._client
        except Exception as err:  # noqa: BLE001
            log.warning("SidecarLlmClient 初始化失败: %s", err)
            return None

    def generate_remediation(
        self,
        goal: str,
        capability: str,
        arguments: dict[str, Any],
        rejection_reason: str,
    ) -> str:
        """根据当前拦截原因，生成给主模型的修复纠偏指导。"""
        client = self._get_client()
        fallback = f"参数未通过安全检查: {rejection_reason}，请修正后重试"
        if client is None:
            return fallback

        try:
            prompt = (
                f"你是一个工具调用自愈指导专家。主 Agent 正在执行目标: '{goal}'。\n"
                f"它发起了工具调用 `{capability}`，参数为: {json.dumps(arguments, ensure_ascii=False)}。\n"
                f"该调用被安全侧拦截，理由为: {rejection_reason}。\n"
                f"请用一两句话给出精炼、明确、具有建设性的参数修改或自愈建议，不要输出额外废话。"
            )
            response = client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=150,
                temperature=0.2,
            )
            content = response.choices[0].message.content or ""
            cleaned = content.strip()
            return cleaned if cleaned else fallback
        except Exception as err:  # noqa: BLE001
            log.warning("Sidecar 生成纠偏建议失败，降级为默认文案: %s", err)
            return fallback

    def compact_observation(
        self,
        call_id: str,
        capability: str,
        payload: dict[str, Any] | str,
        max_chars: int = 1200,
    ) -> SidecarCompactedObservation:
        """对超过预算的超长工具输出进行动态压缩与实体事实浓缩。"""
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        orig_len = len(text)

        if orig_len <= max_chars:
            return SidecarCompactedObservation(
                callId=call_id,
                capability=capability,
                originalChars=orig_len,
                compactedChars=orig_len,
                summary=text[:100] + ("..." if orig_len > 100 else ""),
                keyFacts=[],
            )

        client = self._get_client()
        if client is None:
            # 确定性截断兜底
            snippet = text[:max_chars]
            return SidecarCompactedObservation(
                callId=call_id,
                capability=capability,
                originalChars=orig_len,
                compactedChars=len(snippet),
                summary=f"内容过长已截断（原始 {orig_len} 字符）: {snippet[:150]}...",
                keyFacts=[f"原始体积: {orig_len} 字符"],
            )

        try:
            prompt = (
                f"请对以下工具 `{capability}` 的超长输出内容进行关键事实浓缩提取。\n"
                f"输出要求：返回结构化 JSON，格式为:\n"
                f'{{"summary": "核心结论与概要", "keyFacts": ["要点1", "要点2", ...]}}\n'
                f"原文内容:\n{text[:4000]}"
            )
            resp = client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                max_tokens=300,
                temperature=0.1,
            )
            parsed = json.loads(resp.choices[0].message.content or "{}")
            summary = str(parsed.get("summary") or text[:150])
            facts = [str(f) for f in parsed.get("keyFacts", [])]
            compacted_len = len(summary) + sum(len(f) for f in facts)
            return SidecarCompactedObservation(
                callId=call_id,
                capability=capability,
                originalChars=orig_len,
                compactedChars=compacted_len,
                summary=summary,
                keyFacts=facts,
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Sidecar LLM 动态压缩失败，降级截断: %s", err)
            snippet = text[:max_chars]
            return SidecarCompactedObservation(
                callId=call_id,
                capability=capability,
                originalChars=orig_len,
                compactedChars=len(snippet),
                summary=f"压缩服务降级: {snippet[:100]}...",
                keyFacts=[],
            )
