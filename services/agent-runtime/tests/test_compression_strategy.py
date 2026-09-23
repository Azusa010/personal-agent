from unittest.mock import MagicMock

import pytest
from typesafe_sdk import Choice

from personal_agent.conversation.compression.models import (
    LifecycleTier,
    TaskType,
)
from personal_agent.conversation.compression.strategy import (
    classify_lifecycle,
    evaluate_window_pressure,
    infer_task_type,
    select_compression_candidates,
)
from personal_agent.conversation.model.gateway import Observation
from personal_agent.protocol.models import Turn


def test_evaluate_window_pressure():
    """验证主 Agent 上下文窗口负载率判定。"""
    # 负载达到 75% 时触发
    assert evaluate_window_pressure(current_tokens=6000, max_window_tokens=8000, ratio_threshold=0.75) is True
    # 负载 62.5% 未达 75% 警戒水位，不触发
    assert evaluate_window_pressure(current_tokens=5000, max_window_tokens=8000, ratio_threshold=0.75) is False
    # 超过 75% 必须触发
    assert evaluate_window_pressure(current_tokens=7500, max_window_tokens=8000, ratio_threshold=0.75) is True

    # 异常参数防御
    with pytest.raises(ValueError):
        evaluate_window_pressure(current_tokens=-1, max_window_tokens=8000)
    with pytest.raises(ValueError):
        evaluate_window_pressure(current_tokens=100, max_window_tokens=0)


def test_select_compression_candidates():
    """验证保留近期活跃窗口，靶向提取较早对话与历史 tool results。"""
    history = [
        Turn(role="user", text="你好，请帮我调查公司高管"),
        Turn(role="assistant", text="收到，我先列出目录下的文件"),
        Turn(role="user", text="重点关注 2024 年离职的人"),
        Turn(role="assistant", text="正在提取相关 PDF 文档"),
    ]

    obs1 = Observation(callId="call-1", capability="filesystem_list", ok=True, payload={"files": ["a.pdf", "b.pdf"]})
    obs2 = Observation(callId="call-2", capability="document_extract_pdf", ok=True, payload={"text": "Sutskever 于 2024 年 5 月离开 OpenAI..."})
    obs3 = Observation(callId="call-3", capability="filesystem_move", ok=True, payload={"moved": True})

    cand_turns, cand_obs = select_compression_candidates(
        history=history,
        observations=[obs1, obs2, obs3],
        keep_recent_turns=2,
        keep_recent_obs=1,
    )

    # 较早的对话被选入候选（前 2 轮），最近 2 轮被保留
    assert len(cand_turns) == 2
    assert cand_turns[0].text == "你好，请帮我调查公司高管"
    assert cand_turns[1].text == "收到，我先列出目录下的文件"

    # 较早的工具观察被选入候选（obs1, obs2），最新的 obs3 被保留
    assert len(cand_obs) == 2
    assert cand_obs[0].callId == "call-1"
    assert cand_obs[1].callId == "call-2"


def test_infer_task_type_heuristic_offline():
    """验证在无 Jev 客户端或离线环境下，自适应回退到启发式规则。"""
    assert infer_task_type("查找并整理所有联合创始人名单") == TaskType.RETRIEVAL
    assert infer_task_type("列出下载目录下的财务文件清单") == TaskType.RETRIEVAL
    assert infer_task_type("分析这次架构调整的原因与潜在商业影响") == TaskType.ANALYTICAL
    assert infer_task_type("对比两家公司的核心技术优势") == TaskType.ANALYTICAL
    assert infer_task_type("构思一段吸引人的新产品宣传语") == TaskType.CREATIVE
    assert infer_task_type("设计一个幽默的助手开场白") == TaskType.CREATIVE


def test_infer_task_type_jev_success():
    """验证传入 Jev 客户端时，优先使用 Jev 模型的结构化决策。"""
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client

    # 1. 模拟 Jev 做出检索型决策
    mock_answer = MagicMock()
    mock_answer.choice = "retrieval"
    mock_response = MagicMock()
    mock_response.choices = {"task_type": mock_answer}
    mock_response.answers = {"task_type": mock_answer}
    mock_client.system_one.return_value = mock_response

    res = infer_task_type("提取合同第一条条款", client=mock_client)
    assert res == TaskType.RETRIEVAL

    # 契约底线断言（保留）：验证向 Jev 传递的状态与题目结构
    mock_client.system_one.assert_called_once()
    _, call_kwargs = mock_client.system_one.call_args
    assert call_kwargs["state"] == {"task_goal": "提取合同第一条条款"}
    assert "task_type" in call_kwargs["questions"]
    assert isinstance(call_kwargs["questions"]["task_type"], Choice)

    # 2. 模拟 Jev 做出分析型决策
    mock_client.reset_mock()
    mock_client.__enter__.return_value = mock_client
    mock_answer.choice = "analytical"
    res_analytical = infer_task_type("评估该策略的隐蔽风险", client=mock_client)
    assert res_analytical == TaskType.ANALYTICAL

    # 3. 模拟 Jev 做出创作型决策
    mock_client.reset_mock()
    mock_client.__enter__.return_value = mock_client
    mock_answer.choice = "creative"
    res_creative = infer_task_type("撰写一段富有感染力的口号", client=mock_client)
    assert res_creative == TaskType.CREATIVE


def test_infer_task_type_jev_fallback_on_exception():
    """验证 Jev 客户端调用抛出异常时，平滑降级至启发式规则（CON-006 fail-safe）。"""
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.system_one.side_effect = RuntimeError("网络不可达或超时")

    res = infer_task_type("分析这次架构调整的原因与潜在商业影响", client=mock_client)
    assert res == TaskType.ANALYTICAL


def test_infer_task_type_jev_fallback_on_invalid_choice():
    """验证 Jev 返回未知或非法选项时，平滑降级至启发式规则。"""
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_answer = MagicMock()
    mock_answer.choice = "some_unknown_choice"
    mock_response = MagicMock()
    mock_response.choices = {"task_type": mock_answer}
    mock_response.answers = {"task_type": mock_answer}
    mock_client.system_one.return_value = mock_response

    res = infer_task_type("构思一段吸引人的新产品宣传语", client=mock_client)
    assert res == TaskType.CREATIVE


def test_classify_lifecycle():
    """验证根据工具能力特性划分生命周期分层。"""
    # 状态执行细节 -> L0
    assert classify_lifecycle("terminal_execute") == LifecycleTier.EPHEMERAL_L0
    assert classify_lifecycle("filesystem_create_dir") == LifecycleTier.EPHEMERAL_L0
    assert classify_lifecycle("filesystem_move") == LifecycleTier.EPHEMERAL_L0
    assert classify_lifecycle("notification_send") == LifecycleTier.EPHEMERAL_L0

    # 知识/大文本提取 -> L1
    assert classify_lifecycle("document_extract_pdf") == LifecycleTier.TASK_SCOPED_L1
    assert classify_lifecycle("filesystem_list") == LifecycleTier.TASK_SCOPED_L1
