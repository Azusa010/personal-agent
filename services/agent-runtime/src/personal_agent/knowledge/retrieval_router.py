"""PersonalAgent 双轨检索路由器 (RetrievalRouter)

基于 Jev (TypeSafe System One 极速决策模型) 驱动的双轨检索意图分流与深层检索信息充足性决策中枢：
1. 意图路由：将用户查询自适应分流至 FAST_TRACK（PostgreSQL 毫秒级单点事实检索）或 DEEP_TRACK（OpenViking 维基全景知识库）；
2. 充足性评估：在深层检索中，评估 L1 概览信息是否足以解答提问，按需自动深钻 L2 细节与图谱漫游；
3. 平滑降级：在无 Jev 客户端或离线环境下，安全回退至本地启发式规则（CON-006 fail-safe）。
"""

import logging
import os
from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class RetrievalRoute(str, Enum):
    """检索轨道类型枚举。"""

    FAST_TRACK = "fast_track"  # 快速轨：PostgreSQL 混合检索 (偏好/事实/配置)
    DEEP_TRACK = "deep_track"  # 深层轨：OpenViking 维基 + RAPTOR (架构/演进/对比)


ROUTE_CHOICE_MAP = {
    "fast_track": RetrievalRoute.FAST_TRACK,
    "fast": RetrievalRoute.FAST_TRACK,
    "deep_track": RetrievalRoute.DEEP_TRACK,
    "deep": RetrievalRoute.DEEP_TRACK,
}


def _route_query_heuristic(query: str) -> RetrievalRoute:
    """离线本地启发式规则兜底（当 Jev 不可用时调用）。"""
    q = query.lower()
    deep_keywords = (
        "对比",
        "架构",
        "演进",
        "区别",
        "全面",
        "总结",
        "综述",
        "为什么",
        "历史",
    )
    if any(k in q for k in deep_keywords):
        return RetrievalRoute.DEEP_TRACK
    return RetrievalRoute.FAST_TRACK


def route_query_intent(query: str, client: Any | None = None) -> RetrievalRoute:
    """根据用户查询意图，自适应判断应走快速单点检索还是深层全景分析。

    契约要求：
    1. Jev / 决策模型优先：
       - 若未传入显式 `client`，尝试从环境变量 `TYPESAFE_API_KEY` 初始化 `TypeSafeClient`；
       - 若 `jev_client` 可用，调用 `system_one`，传递 `{"query": query}` 与 `Choice` 问题；
       - 识别 options:
         - "fast_track": 单点事实、用户偏好、配置项、账号、备忘录等；
         - "deep_track": 技术方案对比、架构设计、历史演进、长篇规范或深度推演；
       - 返回映射后的 `RetrievalRoute`；
    2. 容错与平滑降级：
       - 若客户端未配置、调用抛出异常或返回未知选项，记录 warning 日志并平滑降级调用 `_route_query_heuristic(query)`。

    :param query: 用户输入的查询文本
    :param client: 可选的 Jev 决策客户端 (TypeSafeClient)
    :returns: 路由结果枚举 (FAST_TRACK 或 DEEP_TRACK)
    """
    jev_client = client
    if jev_client is None:
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if api_key:
            try:
                from typesafe_sdk import TypeSafeClient

                jev_client = TypeSafeClient()
            except Exception as err:  # noqa: BLE001
                logger.warning("TypeSafeClient 实例化失败: %s", err)

    if jev_client is not None:
        from typesafe_sdk import Choice

        try:
            response = jev_client.system_one(
                state={"query": query},
                questions={
                    "route": Choice(
                        instructions="分析用户查询意图，判断应走快速单点检索还是深层全景分析：",
                        criteria={
                            "fast_track": "用户查询单点事实、用户个人习惯偏好、配置项、账号、联系方式、具体代码行或备忘录。",
                            "deep_track": "用户查询架构演进、技术方案对比、跨文档宏观总结、长篇规范或深度因果推演。",
                        },
                    )
                },
            )
            choice_val = str(response.answers["route"].choice).strip().lower()
            return ROUTE_CHOICE_MAP.get(choice_val, _route_query_heuristic(query))
        except Exception as err:  # noqa: BLE001
            logger.warning("Jev route_query_intent 调用异常，降级为规则: %s", err)
    return _route_query_heuristic(query)


def is_context_sufficient(
    query: str,
    context: str,
    client: Any | None = None,
) -> bool:
    """评估当前所提供的检索上下文（如 L1 概览）是否已经足够完整准确地回答用户提问。

    契约要求：
    1. 边界防御：
       - 若 `context` 为空或纯空白，显然不足，直接返回 `False`；
    2. Jev / 决策模型优先：
       - 若可用，调用 `system_one`，传递 `{"query": query, "retrieved_context": context}`；
       - 提问 `sufficiency`（Choice 包含 "sufficient" 与 "need_deeper" 两档）；
       - 若判定为 "sufficient"，返回 `True`；若判定为 "need_deeper"，返回 `False`；
    3. 容错与平滑降级：
       - 若客户端未配置或调用异常，根据兜底规则判定（如上下文长度与内容非空），避免系统阻塞。

    :param query: 用户问题
    :param context: 当前阶段检索提取的上下文文本
    :param client: 可选的 Jev 决策客户端
    :returns: 足够返回 True，不足需深钻返回 False
    """
    if not context or not context.strip():
        return False
    jev_client = client
    if jev_client is None:
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if api_key:
            try:
                from typesafe_sdk import TypeSafeClient

                jev_client = TypeSafeClient()
            except Exception as err:  # noqa: BLE001
                logger.warning("TypeSafeClient 实例化失败: %s", err)
    if jev_client is not None:
        from typesafe_sdk import Choice

        try:
            response = jev_client.system_one(
                state={"query": query, "retrieved_context": context},
                questions={
                    "sufficiency": Choice(
                        instructions="评估当前所提供的检索上下文是否已经足够完整准确地回答用户提问：",
                        criteria={
                            "sufficient": "当前上下文已包含回答用户问题所需的关键核心信息，无需进一步钻取底层技术细节。",
                            "need_deeper": "当前上下文过于宏观、信息不完整或缺少具体关键细节，必须进一步深钻底层详细文档或图谱。",
                        },
                    )
                },
            )
            choice_val = str(response.answers["sufficiency"].choice).strip().lower()
            return choice_val in ("sufficient", "true", "yes")
        except Exception as err:  # noqa: BLE001
            logger.warning(
                "Jev is_context_sufficient 调用异常，降级为默认判定: %s", err
            )
    return len(context.strip()) > 50  # 简单启发式：上下文长度超过 50 字符视为足够


async def execute_routed_retrieval(
    query: str,
    fast_retriever_fn: Callable[[str], Awaitable[list[Any]]],
    load_l1_overview_fn: Callable[[str], Awaitable[str]],
    deep_drill_down_fn: Callable[[str, str], Awaitable[list[Any]]],
    client: Any | None = None,
) -> dict[str, Any]:
    """统一双轨检索路由调度中枢。"""
    route = route_query_intent(query, client=client)

    if route == RetrievalRoute.FAST_TRACK:
        results = await fast_retriever_fn(query)
        return {
            "route": RetrievalRoute.FAST_TRACK.value,
            "stage": "fast_hit",
            "results": results,
        }

    # 深层知识轨流程
    l1_overview = await load_l1_overview_fn(query)
    sufficient = is_context_sufficient(query, l1_overview, client=client)

    if sufficient:
        logger.info("[retrieval_router] L1 概览信息已足够回答，无需深钻")
        return {
            "route": RetrievalRoute.DEEP_TRACK.value,
            "stage": "l1_overview",
            "content": l1_overview,
            "sufficient": True,
        }

    logger.info("[retrieval_router] L1 概览信息不足，启动深钻 L2 / RAPTOR 跨层检索")
    drilled_results = await deep_drill_down_fn(query, l1_overview)
    return {
        "route": RetrievalRoute.DEEP_TRACK.value,
        "stage": "l2_drilled",
        "content": l1_overview,
        "details": drilled_results,
        "sufficient": False,
    }
