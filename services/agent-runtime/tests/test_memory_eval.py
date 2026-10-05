"""用户记忆与知识库评测系统核心单元与集成测试。

覆盖：
1. 评测清单 memory_cases.json 的反序列化与契约完整性校验
2. 内存 RAG (InMemoryRagIndex) 倒排分词与 BM25 检索能力
3. 三种记忆机制（JsonCards / PureRag / Hybrid）上下文装配行为
4. 四档制归一化、加权计算 (essential 50%, important 各 25%)
5. 幻觉一票否决 (veto fail -> 强制清零与判定失败)
6. 门禁阻断 (essential 未及格时，即使总分达标依然判 Fail)
7. 表 7-3 统计矩阵聚合与 Markdown 报告渲染
8. CI 确定性模式全链路冒烟
"""

from pathlib import Path

from personal_agent.eval.in_memory_rag import InMemoryRagIndex
from personal_agent.eval.judge import (
    calculate_case_score,
)
from personal_agent.eval.models import (
    CapabilityTier,
    DimensionScore,
    EvaluationVerdict,
    MemoryEvalCase,
    MemoryStrategyType,
    SessionMessage,
    VetoScore,
)
from personal_agent.eval.reporter import (
    aggregate_eval_matrix,
    render_markdown_table,
)
from personal_agent.eval.runner import (
    load_memory_cases,
)
from personal_agent.eval.strategies import (
    HybridStrategy,
    JsonCardsStrategy,
    PureRagStrategy,
)
from personal_agent.protocol.models import UserMemoryCard


def _get_cases_path() -> Path:
    # 动态定位根目录 tests/evals/memory_cases.json
    cur = Path(__file__).resolve()
    for parent in cur.parents:
        target = parent / "tests" / "evals" / "memory_cases.json"
        if target.exists():
            return target
    raise FileNotFoundError("未在任何上级目录找到 tests/evals/memory_cases.json")


def test_load_memory_cases_manifest():
    """验证评测清单文件能被正常加载且符合 Pydantic 模型。"""
    cases_path = _get_cases_path()
    cases = load_memory_cases(cases_path)

    assert len(cases) >= 12, f"黄金用例数应不少于 12 条，当前: {len(cases)}"

    # 验证三层能力分类均有覆盖
    tiers = {c.tier for c in cases}
    assert CapabilityTier.BASIC_RECALL in tiers
    assert CapabilityTier.DISAMBIGUATION in tiers
    assert CapabilityTier.CROSS_SESSION_ASSOC in tiers

    # 验证所有用例中的 memory_cards 均为标准生产级 UserMemoryCard
    total_cards = 0
    for case in cases:
        for card in case.memory_cards:
            assert isinstance(card, UserMemoryCard), f"用例 {case.id} 的卡片应为 UserMemoryCard"
            assert card.entryFormat == "card"
            assert card.category in ("preference", "identity", "relationship", "work", "routine", "general")
            assert card.memoryType in ("semantic", "episodic", "procedural")
            assert card.validFrom is not None
            total_cards += 1
    assert total_cards > 10, "测试集应包含多张记忆卡片"

    # 抽取典型用例 "daughter-pediatrician" 验证字段
    case_ped = next((c for c in cases if c.id == "daughter-pediatrician"), None)
    assert case_ped is not None
    assert case_ped.tier == CapabilityTier.CROSS_SESSION_ASSOC
    assert "儿科医生" in case_ped.question
    assert len(case_ped.sessions) == 2
    assert len(case_ped.memory_cards) == 2
    assert case_ped.rubric.veto.weight == "veto"
    assert len(case_ped.rubric.dimensions) == 3

    # 验证消歧用例 city-travel-disambiguation 正确设置了 supersededBy 关系
    case_travel = next((c for c in cases if c.id == "city-travel-disambiguation"), None)
    assert case_travel is not None
    assert len(case_travel.memory_cards) == 2
    shanghai_card = case_travel.memory_cards[0]
    hangzhou_card = case_travel.memory_cards[1]
    assert isinstance(shanghai_card, UserMemoryCard)
    assert isinstance(hangzhou_card, UserMemoryCard)
    assert shanghai_card.supersededBy == hangzhou_card.id
    assert shanghai_card.supersedeReason is not None
    assert hangzhou_card.supersededBy is None


def test_in_memory_rag_indexing_and_search():
    """验证轻量内存 RAG 索引器分词与检索。"""
    sessions = [
        [
            SessionMessage(role="user", content="我家小女儿叫 Lily，今年 3 岁。"),
            SessionMessage(role="assistant", content="收到，Lily 3岁。"),
        ],
        [
            SessionMessage(role="user", content="今天带 Lily 去了儿童医院，看的是儿科 Dr. Chen。"),
            SessionMessage(role="assistant", content="记录 Dr. Chen。"),
        ],
    ]
    index = InMemoryRagIndex.from_sessions(sessions)
    assert len(index.chunks) == 4

    hits = index.search("儿科医生 Dr. Chen", top_k=2)
    assert len(hits) > 0
    # 命中的片段应包含儿科或 Dr. Chen
    hit_texts = " ".join([h.text for h in hits])
    assert "Dr. Chen" in hit_texts or "儿科" in hit_texts


def test_json_cards_strategy_assemble():
    """验证纯 JSON 卡片策略上下文装配：卡片常驻，零动态检索。"""
    case = MemoryEvalCase.model_validate(
        {
            "id": "c1",
            "tier": "basic_recall",
            "question": "我的车牌号？",
            "expected_answer": "浙A88888",
            "sessions": [],
            "memory_cards": [
                {
                    "subject": "车辆登记",
                    "person": "本人",
                    "relationship": "本人",
                    "content": {"plate_number": "浙A88888"},
                }
            ],
            "rubric": {
                "dimensions": [
                    {
                        "name": "事实正确性",
                        "weight": "essential",
                        "scoring": {"4_优秀": "对", "1_不及格": "错"},
                    }
                ],
                "veto": {"name": "幻觉检测", "weight": "veto", "scoring": {"pass": "无", "fail": "有"}},
            },
        }
    )
    index = InMemoryRagIndex()
    strategy = JsonCardsStrategy()
    prompt = strategy.assemble_prompt(case, index)

    assert "<user_memory>" in prompt
    assert "浙A88888" in prompt
    assert "<retrieved_history>" not in prompt


def test_pure_rag_strategy_assemble():
    """验证纯 RAG 策略上下文装配：无预置卡片，动态注入检索对话。"""
    case = MemoryEvalCase.model_validate(
        {
            "id": "c2",
            "tier": "basic_recall",
            "question": "我的车牌号？",
            "expected_answer": "浙A88888",
            "sessions": [
                [SessionMessage(role="user", content="我的车牌号是浙A88888。")]
            ],
            "memory_cards": [],
            "rubric": {
                "dimensions": [
                    {
                        "name": "事实正确性",
                        "weight": "essential",
                        "scoring": {"4_优秀": "对", "1_不及格": "错"},
                    }
                ],
                "veto": {"name": "幻觉检测", "weight": "veto", "scoring": {"pass": "无", "fail": "有"}},
            },
        }
    )
    index = InMemoryRagIndex.from_sessions(case.sessions)
    strategy = PureRagStrategy()
    prompt = strategy.assemble_prompt(case, index)

    assert "<user_memory>" not in prompt
    assert "<retrieved_history>" in prompt
    assert "浙A88888" in prompt


def test_hybrid_strategy_assemble():
    """验证混合系统策略上下文装配：卡片与检索对话双路注入。"""
    case = MemoryEvalCase.model_validate(
        {
            "id": "c3",
            "tier": "cross_session_assoc",
            "question": "我女儿的医生是谁？",
            "expected_answer": "Dr. Chen",
            "sessions": [
                [SessionMessage(role="user", content="带女儿看了儿科 Dr. Chen。")]
            ],
            "memory_cards": [
                {
                    "subject": "家庭成员",
                    "person": "女儿",
                    "relationship": "女儿",
                    "content": {"name": "Lily"},
                }
            ],
            "rubric": {
                "dimensions": [
                    {
                        "name": "事实正确性",
                        "weight": "essential",
                        "scoring": {"4_优秀": "对", "1_不及格": "错"},
                    }
                ],
                "veto": {"name": "幻觉检测", "weight": "veto", "scoring": {"pass": "无", "fail": "有"}},
            },
        }
    )
    index = InMemoryRagIndex.from_sessions(case.sessions)
    strategy = HybridStrategy()
    prompt = strategy.assemble_prompt(case, index)

    # 混合方案必须同时具备长期记忆卡片与检索到的原始会话
    assert "<user_memory>" in prompt, "混合方案必须包含长期记忆卡片 XML"
    assert "Lily" in prompt
    assert "<retrieved_history>" in prompt, "混合方案必须包含检索对话历史 XML"
    assert "Dr. Chen" in prompt


def test_calculate_case_score_all_pass():
    """验证满分情况下的加权计算与门禁放行。"""
    dimensions = [
        DimensionScore(
            name="事实正确性",
            score=4,
            weight="essential",
            normalized_score=1.0,
            reasoning="准确",
        ),
        DimensionScore(
            name="信息完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="完整",
        ),
        DimensionScore(
            name="思考正确性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="严密",
        ),
    ]
    veto = VetoScore(passed=True, reasoning="无幻觉")

    total_score, passed, essential_passed = calculate_case_score(dimensions, veto)
    assert abs(total_score - 1.0) < 1e-4
    assert passed is True
    assert essential_passed is True


def test_calculate_case_score_weighted_calculation():
    """验证 Scale AI 标准权重计算：essential 50% + important 25% * 2。"""
    # 事实正确性: 3分 (0.75) -> 0.75 * 0.50 = 0.375
    # 信息完整性: 4分 (1.00) -> 1.00 * 0.25 = 0.250
    # 思考正确性: 2分 (0.50) -> 0.50 * 0.25 = 0.125
    # 加权和 = 0.375 + 0.250 + 0.125 = 0.75
    dimensions = [
        DimensionScore(
            name="事实正确性",
            score=3,
            weight="essential",
            normalized_score=0.75,
            reasoning="良好",
        ),
        DimensionScore(
            name="信息完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="优秀",
        ),
        DimensionScore(
            name="思考正确性",
            score=2,
            weight="important",
            normalized_score=0.5,
            reasoning="及格",
        ),
    ]
    veto = VetoScore(passed=True, reasoning="无幻觉")

    total_score, passed, essential_passed = calculate_case_score(dimensions, veto)
    assert abs(total_score - 0.75) < 1e-4
    assert passed is True  # 0.75 >= 0.60 且 essential >= 及格(2)
    assert essential_passed is True


def test_calculate_case_score_veto_zeros_everything():
    """验证一票否决项 (veto fail)：即使其他维度全满分，总分也必须强制归 0 且判失败。"""
    dimensions = [
        DimensionScore(
            name="事实正确性",
            score=4,
            weight="essential",
            normalized_score=1.0,
            reasoning="关键词命中",
        ),
        DimensionScore(
            name="信息完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="全",
        ),
        DimensionScore(
            name="思考正确性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="对",
        ),
    ]
    veto = VetoScore(passed=False, reasoning="严重编造就诊日期")

    total_score, passed, _ = calculate_case_score(dimensions, veto)
    assert total_score == 0.0, "一票否决触发时，总分必须强制为 0.0"
    assert passed is False, "一票否决触发时，通过状态必须为 False"


def test_calculate_case_score_essential_fail_gates():
    """验证门禁拦截：即使重要项高分将总分拉过 60%，essential 不及格依然判定 Case 失败。"""
    # 事实正确性: 1分 (0.25, 不及格) -> 0.25 * 0.50 = 0.125
    # 信息完整性: 4分 (1.00) -> 1.00 * 0.25 = 0.250
    # 思考正确性: 4分 (1.00) -> 1.00 * 0.25 = 0.250
    # 加权和 = 0.125 + 0.250 + 0.250 = 0.625 >= 0.60
    dimensions = [
        DimensionScore(
            name="事实正确性",
            score=1,
            weight="essential",
            normalized_score=0.25,
            reasoning="核心实体错误",
        ),
        DimensionScore(
            name="信息完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="回答洋洋洒洒",
        ),
        DimensionScore(
            name="思考正确性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="结构完整",
        ),
    ]
    veto = VetoScore(passed=True, reasoning="无幻觉")

    total_score, passed, essential_passed = calculate_case_score(dimensions, veto)
    assert abs(total_score - 0.625) < 1e-4
    assert essential_passed is False, "essential 维度得分 1 分应判定为 essential 未通过"
    assert passed is False, "essential 未通过时，即便总分达到 0.60 也必须判 Case 失败"


def test_aggregate_eval_matrix_table_7_3():
    """验证多方案分层统计矩阵聚合与表 7-3 渲染。"""
    v1 = EvaluationVerdict(
        case_id="c1",
        strategy=MemoryStrategyType.JSON_CARDS,
        tier=CapabilityTier.BASIC_RECALL,
        total_score=1.0,
        passed=True,
        veto_passed=True,
        essential_passed=True,
        dimension_scores=[],
        veto_score=VetoScore(passed=True),
    )
    v2 = EvaluationVerdict(
        case_id="c2",
        strategy=MemoryStrategyType.JSON_CARDS,
        tier=CapabilityTier.CROSS_SESSION_ASSOC,
        total_score=0.0,
        passed=False,
        veto_passed=False,  # veto
        essential_passed=False,
        dimension_scores=[],
        veto_score=VetoScore(passed=False),
    )
    matrix = aggregate_eval_matrix([v1, v2])

    strat_m = matrix[MemoryStrategyType.JSON_CARDS.value]
    assert strat_m.overall_total == 2
    assert strat_m.overall_passed == 1
    assert strat_m.overall_pass_rate == 0.5
    assert strat_m.veto_triggers_total == 1
    assert strat_m.by_tier[CapabilityTier.BASIC_RECALL].passed == 1
    assert strat_m.by_tier[CapabilityTier.CROSS_SESSION_ASSOC].passed == 0

    md_table = render_markdown_table(matrix)
    assert "Advanced JSON Cards" in md_table
    assert "基础回忆 (Basic)" in md_table
    assert "跨会话隐藏关联 (Cross-Assoc)" in md_table
    assert "综合均分 (Avg)" in md_table


def test_calculate_case_score_strict_mode():
    """验证严苛门禁模式：仅当 essential 达到 4 分优秀且总分 >= 0.85 时才判通过。"""
    # 场景 1: essential=3 (良好), important=4, important=4
    # 总分 = 0.5 * 0.75 + 0.25 * 1.0 + 0.25 * 1.0 = 0.875
    # 常规模式: 通过 (0.875 >= 0.60, essential=3 >= 2)
    # 严苛模式: 失败 (essential 未达到 4 分优秀)
    dims_good = [
        DimensionScore(
            name="事实正确性",
            score=3,
            weight="essential",
            normalized_score=0.75,
            reasoning="良好",
        ),
        DimensionScore(
            name="信息完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="优秀",
        ),
        DimensionScore(
            name="思考正确性",
            score=4,
            weight="important",
            normalized_score=1.0,
            reasoning="优秀",
        ),
    ]
    veto = VetoScore(passed=True, reasoning="无幻觉")

    score_normal, passed_normal, essential_normal = calculate_case_score(
        dims_good, veto, strict=False
    )
    assert abs(score_normal - 0.875) < 1e-4
    assert passed_normal is True
    assert essential_normal is True

    score_strict, passed_strict, essential_strict = calculate_case_score(
        dims_good, veto, strict=True
    )
    assert abs(score_strict - 0.875) < 1e-4
    assert passed_strict is False, "严苛模式下 essential 为 3 分良好必须被拦截为失败"
    assert essential_strict is False

    # 场景 2: essential=4 (优秀), important=3, important=3
    # 总分 = 0.5 * 1.0 + 0.25 * 0.75 + 0.25 * 0.75 = 0.875 >= 0.85
    # 严苛模式: 通过
    dims_excellent = [
        DimensionScore(
            name="事实正确性",
            score=4,
            weight="essential",
            normalized_score=1.0,
            reasoning="优秀",
        ),
        DimensionScore(
            name="信息完整性",
            score=3,
            weight="important",
            normalized_score=0.75,
            reasoning="良好",
        ),
        DimensionScore(
            name="思考正确性",
            score=3,
            weight="important",
            normalized_score=0.75,
            reasoning="良好",
        ),
    ]
    _, passed_strict_2, essential_strict_2 = calculate_case_score(
        dims_excellent, veto, strict=True
    )
    assert passed_strict_2 is True
    assert essential_strict_2 is True
