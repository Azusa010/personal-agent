"""
智能体化与非智能体化 RAG 对比消融实验套件（对标教材《实验 3-8》）。

基于中文司法案例文本，对比：
1. 传统被动单次检索管道 (Passive Single-hop RAG)
2. 智能体化多跳探索循环 (Agentic Multi-hop RAG)

在单跳常识与复杂多跳因果推演（如过失犯罪累犯除外条款判定）中的表现差异。
"""

from typing import Any

from personal_agent.knowledge.agentic_search import (
    QueryLoopDetector,
    calculate_jaccard_similarity,
)

# 模拟司法知识库原始语料
JUDICIAL_CORPUS = [
    {
        "id": "c-1",
        "title": "刑法第一百三十三条",
        "content": "违反交通运输管理法规，因而发生重大事故，致人重伤、死亡或者使公私财产遭受重大损失的，处三年以下有期徒刑或者拘役。",
    },
    {
        "id": "c-2",
        "title": "刑法第二百三十五条",
        "content": "过失伤害他人致人重伤的，处三年以下有期徒刑或者拘役。本法另有规定的，依照规定。",
    },
    {
        "id": "c-3",
        "title": "刑法第六十五条【一般累犯】",
        "content": "被判处有期徒刑以上刑罚的犯罪分子，刑罚执行完毕或者赦免以后，在五年以内再犯应当判处有期徒刑以上刑罚之罪的，是累犯，应当从重处罚，但是过失犯罪和不满十八周岁的人犯罪除外。",
    },
    {
        "id": "c-4",
        "title": "最高人民法院量刑指导意见【坦白与自首】",
        "content": "对于自首情节，综合考虑自首的动机、时间、方式以及罪行轻重等情况，可以减少基准刑的40%以下；犯罪较轻的，可以减少基准刑的50%以上或者依法免除处罚。",
    },
]


def mock_passive_search(query: str, top_k: int = 1) -> list[dict[str, Any]]:
    """传统被动单跳检索：仅对原始 Query 做单次词法匹配返回 top 1。"""
    scored = []
    for doc in JUDICIAL_CORPUS:
        score = calculate_jaccard_similarity(query, doc["content"], n_gram=2)
        scored.append((score, doc))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [item[1] for item in scored[:top_k]]


def mock_agentic_search(
    goal: str,
    max_hops: int = 3,
) -> tuple[list[dict[str, Any]], list[str]]:
    """智能体化多跳探索循环：能够根据已获得的观察产生下一跳新的检索意图。"""
    collected_docs: list[dict[str, Any]] = []
    query_history: list[str] = []
    loop_detector = QueryLoopDetector()

    # 第一跳：从目标问题发掘核心案由
    hop1_query = goal
    query_history.append(hop1_query)
    loop_detector.check_and_record("knowledge_search", hop1_query)
    results1 = mock_passive_search(hop1_query, top_k=1)
    collected_docs.extend(results1)

    # 智能体根据第一跳结果发现涉及前科与累犯问题，发起第二跳意图转向
    if any("过失" in d["content"] for d in results1) and any(
        kw in goal for kw in ("前科", "累犯", "释放", "有期徒刑")
    ):
        hop2_query = "刑法 累犯 认定条件 过失犯罪 除外"
        is_loop, _ = loop_detector.check_and_record(
            "knowledge_search", hop2_query
        )
        if not is_loop:
            query_history.append(hop2_query)
            results2 = mock_passive_search(hop2_query, top_k=1)
            collected_docs.extend(results2)

    return collected_docs, query_history


def test_ablation_single_hop_case():
    """单跳案例：基础法条检索（Passive 与 Agentic 均可精准召回）。"""
    question = "过失伤害他人致人重伤的法定刑标准"

    # 被动单跳
    passive_docs = mock_passive_search(question, top_k=1)
    assert len(passive_docs) == 1
    assert "第二百三十五条" in passive_docs[0]["title"]

    # 智能体多跳
    agentic_docs, _queries = mock_agentic_search(question, max_hops=1)
    assert len(agentic_docs) >= 1
    assert "第二百三十五条" in agentic_docs[0]["title"]


def test_ablation_multi_hop_case():
    """多跳案例：醉酒过失致人重伤 + 5年前有盗窃前科（量刑是否认定累犯）。

    核心法理：
    刑法第 65 条明确规定“过失犯罪和不满十八周岁的人犯罪除外”。
    因此后罪为过失犯罪者，绝对不构成累犯！
    被动单跳检索只能命中过失致人重伤，遗漏了累犯除外条款；
    智能体化多跳检索成功联动第 65 条，实现完整推理闭环。
    """
    case_goal = (
        "行为人过失致人重伤，5年前曾因盗窃被判处有期徒刑刑满释放，本案是否构成累犯？"
    )

    # 1. 传统被动单跳管道表现
    passive_docs = mock_passive_search(case_goal, top_k=1)
    # 被动检索未能关联到刑法第 65 条（累犯除外）
    passive_titles = [d["title"] for d in passive_docs]
    assert "刑法第六十五条【一般累犯】" not in passive_titles

    # 2. 智能体化 ReAct 多跳探索循环表现
    agentic_docs, query_hops = mock_agentic_search(case_goal, max_hops=2)
    agentic_titles = [d["title"] for d in agentic_docs]

    # 断言智能体化检索发起至少 2 跳，并精准捕获第 65 条累犯除外规定
    assert len(query_hops) >= 2
    assert "刑法第六十五条【一般累犯】" in agentic_titles

    # 综合证据充分度验证
    all_content = " ".join(d["content"] for d in agentic_docs)
    assert "过失犯罪和不满十八周岁的人犯罪除外" in all_content
