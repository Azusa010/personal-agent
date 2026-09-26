"""
Agentic RAG 智能体化搜索与死循环探测机制测试套件。
"""

from personal_agent.conversation.model.gateway import Observation
from personal_agent.knowledge.agentic_search import (
    QueryLoopDetector,
    SufficiencyEvaluator,
    build_reflection_prompt,
    calculate_jaccard_similarity,
    detect_query_loop,
)


def test_calculate_jaccard_similarity():
    # 1. 完全相同
    assert calculate_jaccard_similarity("过失致人重伤", "过失致人重伤") == 1.0
    assert calculate_jaccard_similarity("Hello World", "hello world") == 1.0

    # 2. 空字符串边界
    assert calculate_jaccard_similarity("", "") == 1.0
    assert calculate_jaccard_similarity("过失犯罪", "") == 0.0
    assert calculate_jaccard_similarity("", "故意伤害") == 0.0

    # 3. 完全无交集
    assert calculate_jaccard_similarity("交通肇事", "虚假诉讼") == 0.0

    # 4. 高度相似度（部分词重叠）
    sim = calculate_jaccard_similarity("过失致人重伤量刑标准", "过失致人重伤量刑参考")
    assert sim > 0.6


def test_detect_query_loop_boundary_cases():
    # 查询样本数少于 2 条不构成死循环
    assert detect_query_loop([]) is False
    assert detect_query_loop(["唯一检索词"]) is False
    assert detect_query_loop(["", "   "]) is False
    assert detect_query_loop(["首条查询", ""]) is False


def test_detect_query_loop_consecutive_duplicates():
    # 连续完全相同检索
    assert detect_query_loop(["故意伤害 构成要件", "故意伤害 构成要件"]) is True

    # 连续高度重合检索（> 0.8）
    queries = [
        "刑法 累犯 认定条件 与量刑影响",
        "刑法 累犯 认定条件 与量刑标准",
    ]
    assert detect_query_loop(queries, threshold=0.75) is True


def test_detect_query_loop_diverse_queries():
    # 正常多跳探索，关键词发生显著迁移
    queries = [
        "过失致人重伤 立案标准",
        "自首与坦白 司法解释 认定要件",
        "附带民事赔偿 谅解书 酌定从宽幅度",
    ]
    assert detect_query_loop(queries) is False


def test_detect_query_loop_repeated_in_window():
    # 窗口内存在多次重复纠缠
    queries = [
        "盗窃罪 数额较大 认定标准",
        "民法典 侵权赔偿",
        "盗窃罪 数额较大 处罚标准",
        "盗窃罪 数额较大 判定标准",
    ]
    # "盗窃罪 数额较大 判定标准" 与 "认定标准"、"处罚标准" 相似度均 >= 0.6
    assert detect_query_loop(queries, threshold=0.6) is True


def test_query_loop_detector_integration():
    detector = QueryLoopDetector(threshold=0.8, window_size=3)

    # 非检索能力不受检查
    is_loop, _ = detector.check_and_record("document_extract_pdf", "dummy")
    assert is_loop is False

    # 首次正常检索
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "正当防卫 限度条件"
    )
    assert is_loop is False
    assert prompt is None

    # 第二次不同检索
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "假想防卫 过失致人死亡"
    )
    assert is_loop is False

    # 第三次发起与上一次几乎一致的检索 -> 触发循环拦截
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "假想防卫 过失致人死亡"
    )
    assert is_loop is True
    assert prompt is not None
    assert "系统反思提示" in prompt

    # 重置后应恢复正常
    detector.reset()
    assert len(detector.queries) == 0


def test_query_loop_detector_jev_score_evaluation():
    from unittest.mock import MagicMock

    mock_client = MagicMock()
    mock_resp = MagicMock()
    # 初始返回一个中高分 (2.5)，表示有效新颖度推进
    mock_resp.answers = {"novelty_score": MagicMock(score=2.5)}
    mock_client.system_one.return_value = mock_resp

    detector = QueryLoopDetector(threshold=0.95, window_size=4, client=mock_client)

    # 1. 第一次检索
    is_loop, _ = detector.check_and_record("knowledge_search", "交通肇事罪 赔偿标准")
    assert is_loop is False

    # 2. 第二次检索（字面不完全相同，Jaccard 过滤通过，但 JEV 评估新颖度）
    # 场景 A: JEV 给高分 2.5 -> 属于有效多跳推进，放行
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "交通事故 责任认定 比例划分"
    )
    assert is_loop is False
    assert prompt is None
    assert detector.scores == [2.5]

    # 场景 B: 第三次检索，字面仍然不同，但语义无新线索，JEV 给出极低分 0.4 (<= 0.6)
    mock_resp.answers = {"novelty_score": MagicMock(score=0.4)}
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "交通事故 双方过错 责任分担"
    )
    assert is_loop is True
    assert prompt is not None
    assert "系统反思提示" in prompt
    assert detector.scores == [2.5, 0.4]

    # 重置
    detector.reset()
    assert len(detector.scores) == 0


def test_query_loop_detector_jev_score_consecutive_low_scores():
    from unittest.mock import MagicMock

    mock_client = MagicMock()
    mock_resp = MagicMock()
    mock_client.system_one.return_value = mock_resp

    detector = QueryLoopDetector(threshold=0.95, window_size=4, client=mock_client)

    detector.check_and_record("knowledge_search", "故意伤害罪 构成要件")

    # 第一次低新颖度 (1.0，介于 0.6~1.2 之间，单次不直接打死)
    mock_resp.answers = {"novelty_score": MagicMock(score=1.0)}
    is_loop, _ = detector.check_and_record(
        "knowledge_search", "故意伤害 立案标准 刑期"
    )
    assert is_loop is False

    # 第二次依然低新颖度 (1.1，连续两次 <= 1.2，边际收益衰减耗尽)
    mock_resp.answers = {"novelty_score": MagicMock(score=1.1)}
    is_loop, prompt = detector.check_and_record(
        "knowledge_search", "故意伤害 赔偿协议 减刑"
    )
    assert is_loop is True
    assert prompt is not None
    assert "系统反思提示" in prompt


def test_build_reflection_prompt():
    prompt = build_reflection_prompt("过失犯罪 量刑")
    assert "过失犯罪 量刑" in prompt
    assert "系统反思提示" in prompt
    assert "多跳探索" in prompt


def test_sufficiency_evaluator():
    evaluator = SufficiencyEvaluator()

    # 无检索观察
    ok, reason = evaluator.evaluate([])
    assert ok is False
    assert "尚未执行" in reason

    # 检索返回空结果
    empty_obs = Observation(
        callId="c-1",
        capability="knowledge_search",
        ok=True,
        payload={"chunks": []},
    )
    ok, reason = evaluator.evaluate([empty_obs])
    assert ok is False
    assert "未命中任何相关知识" in reason

    # 检索命中有效知识块
    hit_obs = Observation(
        callId="c-2",
        capability="knowledge_search",
        ok=True,
        payload={"chunks": [{"id": "chunk-1", "content": "法条正文"}]},
    )
    ok, reason = evaluator.evaluate([hit_obs])
    assert ok is True
    assert "已收集到 1 条" in reason

