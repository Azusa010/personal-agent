"""PersonalAgent 双轨检索路由与 Jev 决策单元测试。"""

from unittest.mock import MagicMock

import pytest

from personal_agent.knowledge.retrieval_router import (
    RetrievalRoute,
    execute_routed_retrieval,
    is_context_sufficient,
    route_query_intent,
)


def test_route_query_intent_with_jev():
    """验证使用 Jev (TypeSafeClient) 做出精准语义意图分类。"""
    mock_jev = MagicMock()

    # 1. 模拟 Jev 做出快速轨决策
    mock_jev.system_one.return_value = MagicMock(
        answers={"route": MagicMock(choice="fast_track")}
    )
    route1 = route_query_intent("我的常用开发配置是什么", client=mock_jev)
    assert route1 == RetrievalRoute.FAST_TRACK
    mock_jev.system_one.assert_called_once()

    # 2. 模拟 Jev 做出深层轨决策
    mock_jev.system_one.reset_mock()
    mock_jev.system_one.return_value = MagicMock(
        answers={"route": MagicMock(choice="deep_track")}
    )
    route2 = route_query_intent(
        "对比分析 RISC-V 与 ARM 在能效和生态上的优缺点", client=mock_jev
    )
    assert route2 == RetrievalRoute.DEEP_TRACK


def test_route_query_intent_fallback():
    """验证在无 Jev 客户端或调用异常时，平滑降级至本地启发式规则。"""
    # 1. client 为 None 且无 API key
    route_deep = route_query_intent("x86 架构历史演进与总结", client=None)
    assert route_deep == RetrievalRoute.DEEP_TRACK

    route_fast = route_query_intent("明天的日程安排", client=None)
    assert route_fast == RetrievalRoute.FAST_TRACK

    # 2. Jev 调用抛出异常时降级
    mock_failing_jev = MagicMock()
    mock_failing_jev.system_one.side_effect = RuntimeError("network connection lost")
    fallback_route = route_query_intent(
        "对比两个系统的并发模型", client=mock_failing_jev
    )
    assert fallback_route == RetrievalRoute.DEEP_TRACK


def test_is_context_sufficient_boundary():
    """验证上下文为空时的边界直接阻断。"""
    mock_jev = MagicMock()
    # 空内容直接返回 False，不调用模型
    assert is_context_sufficient("测试问题", "", client=mock_jev) is False
    assert is_context_sufficient("测试问题", "   \n\t  ", client=mock_jev) is False
    mock_jev.system_one.assert_not_called()


def test_is_context_sufficient_with_jev():
    """验证使用 Jev 评估检索上下文是否已足以回答提问。"""
    mock_jev = MagicMock()

    # 1. 判定为足够 (sufficient)
    mock_jev.system_one.return_value = MagicMock(
        answers={"sufficiency": MagicMock(choice="sufficient")}
    )
    res_sufficient = is_context_sufficient(
        query="AVX 指令集的寄存器位宽是多少？",
        context="AVX 将寄存器扩展为 256 位 YMM 寄存器，提供更宽的 SIMD 吞吐。",
        client=mock_jev,
    )
    assert res_sufficient is True

    # 2. 判定为不足 (need_deeper)
    mock_jev.system_one.reset_mock()
    mock_jev.system_one.return_value = MagicMock(
        answers={"sufficiency": MagicMock(choice="need_deeper")}
    )
    res_insufficient = is_context_sufficient(
        query="VADDPS 指令的具体二进制操作码与编码格式是什么？",
        context="本章概述了 x86 向量指令集的发展历程，详情请见各指令规格表。",
        client=mock_jev,
    )
    assert res_insufficient is False


@pytest.mark.asyncio
async def test_execute_routed_retrieval_integration():
    """验证统一双轨检索路由调度中枢的高层调用编排。"""
    mock_jev = MagicMock()

    fast_called = []
    l1_called = []
    deep_drill_called = []

    async def mock_fast_retriever(query: str):
        fast_called.append(query)
        return [{"id": "card_1", "text": "用户偏好使用暗黑模式"}]

    async def mock_load_l1(query: str):
        l1_called.append(query)
        return "【L1 概览】这是 CPU 架构的总体概述"

    async def mock_deep_drill(query: str, l1: str):
        deep_drill_called.append((query, l1))
        return [{"id": "leaf_l2", "text": "具体微架构流水线细节"}]

    # 1. 场景一：快速轨命中
    mock_jev.system_one.return_value = MagicMock(
        answers={"route": MagicMock(choice="fast_track")}
    )
    res1 = await execute_routed_retrieval(
        query="用户的界面偏好是什么",
        fast_retriever_fn=mock_fast_retriever,
        load_l1_overview_fn=mock_load_l1,
        deep_drill_down_fn=mock_deep_drill,
        client=mock_jev,
    )
    assert res1["route"] == "fast_track"
    assert len(fast_called) == 1
    assert len(l1_called) == 0

    # 2. 场景二：深层轨且 L1 概览已足够
    mock_jev.system_one.side_effect = [
        # 第一次判定 route
        MagicMock(answers={"route": MagicMock(choice="deep_track")}),
        # 第二次判定 sufficiency
        MagicMock(answers={"sufficiency": MagicMock(choice="sufficient")}),
    ]
    res2 = await execute_routed_retrieval(
        query="CPU 架构主要经历了哪些代际？",
        fast_retriever_fn=mock_fast_retriever,
        load_l1_overview_fn=mock_load_l1,
        deep_drill_down_fn=mock_deep_drill,
        client=mock_jev,
    )
    assert res2["route"] == "deep_track"
    assert res2["stage"] == "l1_overview"
    assert res2["sufficient"] is True
    assert len(l1_called) == 1
    assert len(deep_drill_called) == 0

    # 3. 场景三：深层轨且 L1 概览不足，自动触发深钻 L2 / RAPTOR
    mock_jev.system_one.side_effect = [
        # 第一次判定 route
        MagicMock(answers={"route": MagicMock(choice="deep_track")}),
        # 第二次判定 sufficiency -> need_deeper
        MagicMock(answers={"sufficiency": MagicMock(choice="need_deeper")}),
    ]
    res3 = await execute_routed_retrieval(
        query="具体的微架构发射槽位宽度是多少？",
        fast_retriever_fn=mock_fast_retriever,
        load_l1_overview_fn=mock_load_l1,
        deep_drill_down_fn=mock_deep_drill,
        client=mock_jev,
    )
    assert res3["route"] == "deep_track"
    assert res3["stage"] == "l2_drilled"
    assert res3["sufficient"] is False
    assert len(deep_drill_called) == 1
