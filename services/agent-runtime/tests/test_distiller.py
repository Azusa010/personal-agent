"""阶段 3 单元测试：递归提炼器（ObservationDistiller）与上下文感知提示词。"""

import json
from unittest.mock import MagicMock

from personal_agent.conversation.compression.distiller import (
    DISTILL_MODEL_ENV,
    ObservationDistiller,
    build_context_aware_prompt,
    resolve_distill_model,
)
from personal_agent.conversation.compression.models import (
    LifecycleTier,
    TaskType,
)
from personal_agent.conversation.model.gateway import Observation


def test_resolve_distill_model(monkeypatch):
    """验证独立提炼模型环境变量解析与平滑降级。"""
    # 1. 优先读取 OPENAI_DISTILL_MODEL
    monkeypatch.setenv(DISTILL_MODEL_ENV, "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    assert resolve_distill_model() == "gpt-4o-mini"

    # 2. 未配提炼模型时，平滑降级复用 OPENAI_MODEL
    monkeypatch.delenv(DISTILL_MODEL_ENV, raising=False)
    assert resolve_distill_model() == "gpt-4o"

    # 3. 两者均未配置时返回默认备选模型名
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    assert resolve_distill_model() == "gpt-4o-mini"


def test_build_context_aware_prompt():
    """验证上下文感知提炼提示词的装配格式。"""
    prompt = build_context_aware_prompt(
        query="查找 2024 年离职的联合创始人",
        context="当前已在工作文档记录了部分架构历史",
        raw_content="Ilya Sutskever 于 2024 年 5 月离开 OpenAI...",
        task_type=TaskType.RETRIEVAL,
    )
    # 严格包含用户指定的两大上下文感知锚点
    assert "Given the search query: 查找 2024 年离职的联合创始人" in prompt
    assert "Current context: 当前已在工作文档记录了部分架构历史" in prompt
    assert "Task Mode: retrieval" in prompt
    assert "Sutskever" in prompt


def test_distiller_ephemeral_l0_folding():
    """验证 L0 瞬时执行细节无需调用大模型，直接折叠为轻量执行凭证。"""
    distiller = ObservationDistiller()
    obs = Observation(
        callId="call-dir-1",
        capability="filesystem_create_dir",
        ok=True,
        payload={"created": True, "path": "/test/path"},
    )
    distilled = distiller.distill_observation(
        observation=obs,
        query="创建目标文件夹",
        context="准备归档文件",
    )
    assert distilled.callId == "call-dir-1"
    assert distilled.capability == "filesystem_create_dir"
    assert distilled.tier == LifecycleTier.EPHEMERAL_L0
    assert "创建目标文件夹" in distilled.summary or "filesystem_create_dir" in distilled.summary
    assert distilled.ok is True


def test_distiller_deep_knowledge_distillation_with_client():
    """验证 L1 深度知识提取时，调用模型并将输出解析为 DistilledObservation。"""
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_choice = MagicMock()
    mock_message = MagicMock()

    # 模拟大模型返回符合规范的 JSON 结构化数据
    mock_json_content = json.dumps({
        "summary": "提取到 Ilya Sutskever 离职事件",
        "facts": [
            {
                "subject": "Ilya Sutskever",
                "predicate": "离开",
                "object": "OpenAI",
                "temporal": "2024年5月",
                "pageRefs": [3]
            }
        ]
    })
    mock_message.content = mock_json_content
    mock_choice.message = mock_message
    mock_response.choices = [mock_choice]
    mock_client.chat.completions.create.return_value = mock_response

    distiller = ObservationDistiller(model="mock-distill-model", client=mock_client)
    obs = Observation(
        callId="call-pdf-1",
        capability="document_extract_pdf",
        ok=True,
        payload={"text": "详细报告：Ilya Sutskever 于 2024 年 5 月离开 OpenAI 公司..."},
    )

    result = distiller.distill_observation(
        observation=obs,
        query="查找高管离职信息",
        context="工作台待补充人事事实",
        task_type=TaskType.RETRIEVAL,
    )

    assert result.callId == "call-pdf-1"
    assert result.tier == LifecycleTier.TASK_SCOPED_L1
    assert len(result.facts) == 1
    assert result.facts[0].subject == "Ilya Sutskever"
    assert result.facts[0].temporal == "2024年5月"
    assert result.distilledChars > 0
    assert mock_client.chat.completions.create.called
