"""personal_agent.conversation.extractor.llm_extractor —— 基于大模型的冷记忆提炼器。

吸收 Mem0、Claude Memory 及 OpenAI 前沿长程记忆范式：
1. 防归因漂移：仅从用户明确表述中提取具有长期沉淀价值的偏好、规范、架构事实；
2. 7 大正交分类：user_preferences, coding_standards, project_architecture,
   tool_experience, business_rules, environmental_specs, other；
3. 严格噪音过滤：对临时报错排查、寒暄、调试重试等瞬态事件强制标记为 NO_OP 或过滤；
4. 结构化输出：返回包含 category, content, confidence, action 的 JSON 数组，转换为 CandidateMemoryItem。
"""

import logging
import re
from collections.abc import Callable
from typing import Any

import json_repair

from personal_agent.conversation.extractor.models import CandidateMemoryItem
from personal_agent.conversation.ledger import LedgerEvent
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelGateway,
)
from personal_agent.conversation.model.json_parser import safe_parse_model_json

log = logging.getLogger(__name__)

EXTRACTION_SYSTEM_PROMPT = """你是一个顶尖的个人全能智能体（Personal Agent）长期记忆与知识提炼专家。
你的职责是从用户与智能体的历史对话事件切片中，精准提炼具备长期沉淀价值的个人偏好、编码规范与架构事实。

【核心原则与防归因漂移准则（参照 Mem0 与 Claude Memory 范式）】：
1. 真实归因（User-Attributed Only）：
   - 只能从用户的明确陈述、要求、纠正或长期指示中提炼记忆。
   - 严禁将智能体自身的建议、推测、临时假设或虚构方案归因为用户的偏好。
   - 严禁过度泛化：不要把用户单次任务的具体输入（例如“帮我翻译这段话”）误提炼为长期偏好。
2. 长期持久价值（Durable vs. Ephemeral）：
   - 仅沉淀跨会话有效的硬性约定、习惯偏好、架构规则、排坑经验。
   - 瞬态噪音严禁入库：单次报错堆栈排查、临时调试命令重试、客套寒暄（如“你好”、“谢谢”、“好的”）等一律归为 NO_OP 或忽略。
3. 7 大正交分类（Category Taxonomy）：
   - user_preferences: 用户个人偏好、交互习惯、工作流风格（如代码风格偏好、编辑器设置、简短输出要求等）
   - coding_standards: 编程规范、命名规则、代码审查标准、类型安全约定（如强制 TypeScript 纯函数、2空格缩进等）
   - project_architecture: 项目全局架构设计、模块分层拓扑、目录组织、核心状态流转
   - tool_experience: 工具/CLI/库的使用经验、踩坑记录、参数陷阱与最佳实践
   - business_rules: 核心业务规则、领域逻辑、计算规则、权限与合规约束
   - environmental_specs: 运行环境规格、Python/Node 版本约束、系统依赖要求
   - other: 其他无法归入上述分类但具有明确长期价值的硬事实
4. 决策动作（Action）：
   - APPEND: 新增或更新某项有效长程记忆。
   - NO_OP: 对话中无任何长期记忆价值（例如纯日常闲聊、临时报错排查、任务临时执行），或者虽然有信息但无需持久化。

【输出格式要求】：
你必须直接返回一个合法的 JSON 数组，严禁包含任何前置或后置说明文本。每个条目包含以下字段：
[
  {
    "category": "user_preferences" | "coding_standards" | "project_architecture" | "tool_experience" | "business_rules" | "environmental_specs" | "other",
    "content": "精炼、明确、客观的第三人称陈述",
    "confidence": 0.0 到 1.0 之间的浮点数（如 0.95）,
    "action": "APPEND" | "NO_OP"
  }
]
如果切片中没有任何值得沉淀的长期记忆，请返回空数组 [] 或仅包含 action 为 NO_OP 的条目。"""


def create_llm_memory_extractor(
    model: ModelGateway,
) -> Callable[[list[LedgerEvent]], list[CandidateMemoryItem]]:
    """创建基于大模型的长程记忆提炼函数。"""

    def extract_fn(events: list[LedgerEvent]) -> list[CandidateMemoryItem]:
        if not events:
            return []

        min_seq = min(e.seq_id for e in events)
        max_seq = max(e.seq_id for e in events)

        lines: list[str] = []
        for ev in events:
            role = ev.event_type
            payload = ev.payload or {}
            text = (
                payload.get("text")
                or payload.get("reply")
                or payload.get("content")
                or payload.get("query")
                or str(payload)
            )
            lines.append(f"[{role.upper()}] (seq={ev.seq_id}): {text}")

        dialogue_text = "\n".join(lines)
        user_prompt = f"请分析以下对话事件，提炼长期记忆与偏好事实：\n\n{dialogue_text}"

        context = ModelContext(
            taskGoal="提炼用户长期记忆与高价值事实",
            systemPrompt=EXTRACTION_SYSTEM_PROMPT,
            progressDocument=user_prompt,
        )

        try:
            decision = model.decide(context)
        except Exception as e:  # noqa: BLE001
            log.warning("提炼记忆模型调用异常: %s", e)
            return []

        raw_text = getattr(decision, "reply", "")
        if not raw_text and hasattr(decision, "result"):
            raw_text = getattr(decision, "result", "")
        if not raw_text:
            return []

        parsed: Any = None
        try:
            parsed = safe_parse_model_json(raw_text)
        except Exception:  # noqa: BLE001
            match = re.search(r"\[[\s\S]*\]", raw_text)
            if match:
                try:
                    parsed = json_repair.repair_json(
                        match.group(0), return_objects=True
                    )
                except Exception:  # noqa: BLE001
                    return []
            else:
                return []

        if isinstance(parsed, dict):
            parsed = [parsed]
        elif not isinstance(parsed, list):
            return []

        candidates: list[CandidateMemoryItem] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            action = str(item.get("action", "APPEND")).strip().upper()
            if action == "NO_OP":
                continue

            category = item.get("category", "other")
            content = item.get("content", "")
            if not content:
                continue

            try:
                conf = float(item.get("confidence", 0.9))
            except (ValueError, TypeError):
                conf = 0.9

            candidates.append(
                CandidateMemoryItem(
                    action=action,
                    category=category,
                    content=content,
                    confidence=conf,
                    source_seq_range=(min_seq, max_seq),
                )
            )

        return candidates

    return extract_fn