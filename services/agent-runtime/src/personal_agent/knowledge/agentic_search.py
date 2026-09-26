"""
智能体化 RAG (Agentic RAG) 搜索控制器与死循环探测反思器。

提供多跳检索中的循环停滞检测 (Jaccard 重复度判定)、系统反思提示生成、
以及检索充分度评价机制（基于《深入理解 AI Agent》第 3 章 3.6 节）。
"""

import logging
import os
from collections.abc import Sequence
from typing import Any, Final

from personal_agent.conversation.model.gateway import Observation

logger = logging.getLogger(__name__)

# 智能体检索类能力集合
SEARCH_CAPABILITIES: Final[frozenset[str]] = frozenset(
    {
        "knowledge_search",
        "user_memory_search",
        "viking_search",
    }
)

DEFAULT_SIMILARITY_THRESHOLD: Final[float] = 0.8
DEFAULT_WINDOW_SIZE: Final[int] = 4


def calculate_jaccard_similarity(s1: str, s2: str, n_gram: int = 2) -> float:
    """计算两个查询文本的字符级 n-gram Jaccard 相似度。

    纯函数，忽略大小写和首尾空格。
    """
    str1 = s1.strip().lower()
    str2 = s2.strip().lower()
    if not str1 and not str2:
        return 1.0
    if not str1 or not str2:
        return 0.0
    if str1 == str2:
        return 1.0

    # 当字符串过短时退化为单字符集合
    if len(str1) < n_gram or len(str2) < n_gram:
        set1 = set(str1)
        set2 = set(str2)
    else:
        set1 = {str1[i : i + n_gram] for i in range(len(str1) - n_gram + 1)}
        set2 = {str2[i : i + n_gram] for i in range(len(str2) - n_gram + 1)}

    intersection = len(set1 & set2)
    union = len(set1 | set2)
    if union == 0:
        return 0.0
    return intersection / union


def detect_query_loop(
    recent_queries: list[str],
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> bool:
    """判定近期检索词列表是否存在循环停滞/死循环。

    # Contract:
    #   - Input: recent_queries: list[str] (按执行先后顺序排序的检索词列表), threshold: float (相似度阈值, 0.0~1.0)
    #   - Output: bool (True 表示陷入死循环停滞，False 表示正常探索推进)
    #   - Invariants: 纯函数，无副作用；
    #   - Boundary conditions:
    #       - 少于 2 条有效查询返回 False；
    #       - 最近一条查询与前一条查询相似度 >= threshold 时返回 True；
    #       - 最近一条查询若与历史窗口内任意两条查询相似度均 >= threshold 时返回 True；
    #       - 过滤空字符串或纯空白检索；
    #   - Test file: tests/test_agentic_search.py
    """
    valid = [q.strip() for q in recent_queries if q and q.strip()]
    if len(valid) < 2:
        return False
    if not valid:
        return False
    latest = valid[-1]
    if calculate_jaccard_similarity(latest, valid[-2]) >= threshold:
        return True

    similar_count = sum(
        1
        for prev in valid[:-1]
        if calculate_jaccard_similarity(latest, prev) >= threshold
    )
    return similar_count >= 2


def build_reflection_prompt(last_query: str) -> str:
    """生成指导模型跳出检索死循环的系统反思提示语。"""
    return (
        f"【系统反思提示】检测到连续发起高度相似检索（'{last_query}'），"
        f"检索已陷入停滞。请勿重复检索相同语义词，建议："
        f"1. 拓展或转换检索关键词与法理维度（多跳探索）；"
        f"2. 若已有关键事实足以回答问题，请直接基于已有证据作答并附带引用。"
    )


class QueryLoopDetector:
    """检索死循环检测器与历史追踪器（支持字符级快速拦截与 JEV Score 语义新颖度级联评估）。"""

    def __init__(
        self,
        threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        window_size: int = DEFAULT_WINDOW_SIZE,
        client: Any | None = None,
    ) -> None:
        self._threshold = threshold
        self._window_size = window_size
        self._client = client
        self._queries: list[str] = []
        self._scores: list[float] = []

    @property
    def queries(self) -> list[str]:
        return list(self._queries)

    @property
    def scores(self) -> list[float]:
        return list(self._scores)

    def check_and_record(self, capability: str, query: str) -> tuple[bool, str | None]:
        """记录查询并检测死循环。

        若非检索类能力或查询为空，直接放行 (False, None)。
        若触发死循环，返回 (True, 反思提示语)。
        """
        if capability not in SEARCH_CAPABILITIES:
            return False, None

        cleaned_query = query.strip()
        if not cleaned_query:
            return False, None

        self._queries.append(cleaned_query)
        window = self._queries[-self._window_size :]

        # 1. 第一级：纯数学 Jaccard 快速筛查（0ms 本地计算，秒杀粗暴复制）
        if detect_query_loop(window, self._threshold):
            prompt = build_reflection_prompt(cleaned_query)
            logger.warning(
                "Jaccard 快速通道检测到检索死循环，拦截工具调用并注入反思: query=%s",
                cleaned_query,
            )
            return True, prompt

        # 2. 第二级：若存在 JEV Client (或环境变量设置)，通过 Score 评测增量新颖度与边际效益
        jev_client = self._client
        if not jev_client:
            api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
            if api_key:
                try:
                    from typesafe_sdk import TypesafeClient

                    jev_client = TypesafeClient(api_key=api_key)
                except Exception as err:  # noqa: BLE001
                    logger.warning("TypeSafeClient 实例化失败: %s", err)

        if jev_client is not None and len(window) >= 2:
            try:
                from typesafe_sdk import Score

                resp = jev_client.system_one(
                    state={
                        "recent_queries": window[:-1],
                        "current_query": cleaned_query,
                    },
                    questions={
                        "novelty_score": Score(
                            instructions="评估当前检索词相对于前序检索词的增量新颖度与推进度（是否引入了新实体、新法理或新维度）。",
                            criteria=[
                                "完全同义或原地打转，毫无新线索，意图完全重复。",
                                "有局部文字微调，但依然停留在同一狭窄话题下，新意极弱。",
                                "在同一法理主题下进行了有价值的延伸或限定，属于递进探索。",
                                "引入全新实体、构成要件或事实分支，属于显著有效多跳推进。",
                            ],
                        )
                    },
                )
                score = float(resp.answers["novelty_score"].score)
                self._scores.append(score)

                # 边际效益衰减与停滞判定：
                # (a) 单次极端停滞（新颖度 <= 0.6 分，即权重几乎全落在级别 0）
                # (b) 连续多次低新意徘徊（最近两次均 <= 1.2 分，即持续在级别 0-1 徘徊）
                is_stagnant = score <= 0.6 or (
                    len(self._scores) >= 2
                    and self._scores[-1] <= 1.2
                    and self._scores[-2] <= 1.2
                )

                if is_stagnant:
                    prompt = build_reflection_prompt(cleaned_query)
                    logger.warning(
                        "JEV Score 评测检测到检索停滞 (score=%.2f)，拦截工具调用并注入反思: query=%s",
                        score,
                        cleaned_query,
                    )
                    return True, prompt
            except Exception as err:  # noqa: BLE001
                logger.warning("JEV Score 调用失败，降级放行: %s", err)

        return False, None

    def reset(self) -> None:
        """重置查询追踪历史与分值记录。"""
        self._queries.clear()
        self._scores.clear()


class SufficiencyEvaluator:
    """多跳检索充分度判定器（基于《深入理解 AI Agent》3.6 节）。"""

    def evaluate(
        self,
        observations: Sequence[Observation],
    ) -> tuple[bool, str]:
        """评估当前观测历史中获取的外部证据是否已充分。"""
        search_obs = [
            o for o in observations if o.capability in SEARCH_CAPABILITIES and o.ok
        ]
        if not search_obs:
            return False, "尚未执行任何有效的检索能力"

        total_items = 0
        for o in search_obs:
            chunks = o.payload.get("chunks", [])
            items = o.payload.get("items", [])
            if isinstance(chunks, list):
                total_items += len(chunks)
            if isinstance(items, list):
                total_items += len(items)

        if total_items == 0:
            return False, "检索已执行，但未命中任何相关知识条目"

        return True, f"已收集到 {total_items} 条相关证据，具备初步作答条件"
