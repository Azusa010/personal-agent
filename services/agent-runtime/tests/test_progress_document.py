"""阶段 2 测试：双轨工作文档管理器（ProgressDocumentManager）。"""


from personal_agent.conversation.compression.document import (
    DOCUMENT_CLOSE_TAG,
    DOCUMENT_OPEN_TAG,
    ProgressDocumentManager,
)
from personal_agent.conversation.compression.models import (
    DistilledFact,
    TaskType,
)


def test_document_manager_initialization():
    """验证工作文档管理器的初始状态。"""
    mgr = ProgressDocumentManager(
        task_goal="整理公司高管变动历史",
        task_type=TaskType.RETRIEVAL,
    )
    assert mgr.state.taskGoal == "整理公司高管变动历史"
    assert mgr.state.taskType == TaskType.RETRIEVAL
    assert len(mgr.state.verifiedFacts) == 0
    assert len(mgr.state.milestones) == 0
    assert len(mgr.state.notes) == 0


def test_document_manager_merge_facts_deduplication():
    """验证增量事实去重合并：相同的主体、动作、客体与时间戳不应重复添加。"""
    mgr = ProgressDocumentManager(task_goal="调查 OpenAI 关键事件")

    fact1 = DistilledFact(
        subject="Ilya Sutskever",
        predicate="离开",
        object="OpenAI",
        temporal="2024年5月",
        pageRefs=[3],
    )
    fact2 = DistilledFact(
        subject="OpenAI",
        predicate="发布",
        object="GPT-4o",
        temporal="2024年5月",
        pageRefs=[12],
    )

    # 首次合并两项
    added_count = mgr.merge_facts([fact1, fact2])
    assert added_count == 2
    assert len(mgr.state.verifiedFacts) == 2

    # 再次合并：包含重复的 fact1 和一个新事实 fact3
    fact3 = DistilledFact(
        subject="Safe Superintelligence",
        predicate="成立",
        object="美国特拉华州",
        temporal="2024年6月",
    )
    added_count_2 = mgr.merge_facts([fact1, fact3])
    assert added_count_2 == 1
    assert len(mgr.state.verifiedFacts) == 3


def test_document_manager_milestones_and_notes():
    """验证里程碑推进与 Agent 主动沉淀笔记。"""
    mgr = ProgressDocumentManager(task_goal="分析报告")
    mgr.add_milestone("步骤 1：PDF 关键段落提取完成")
    mgr.add_note("核心发现：管理层在第二季度发生集中调整")

    assert len(mgr.state.milestones) == 1
    assert "步骤 1" in mgr.state.milestones[0]
    assert len(mgr.state.notes) == 1
    assert "核心发现" in mgr.state.notes[0]


def test_document_manager_render_structure():
    """验证 Markdown 渲染必须包含特定结构标签与关键内容。"""
    mgr = ProgressDocumentManager(
        task_goal="梳理高管变动",
        task_type=TaskType.RETRIEVAL,
    )
    mgr.merge_facts(
        [
            DistilledFact(
                subject="Ilya Sutskever",
                predicate="离开",
                object="OpenAI",
                temporal="2024年5月",
                pageRefs=[3],
            )
        ]
    )
    mgr.add_milestone("完成变动提取")
    mgr.add_note("核实完毕，无争议")

    md = mgr.render()
    assert DOCUMENT_OPEN_TAG in md
    assert DOCUMENT_CLOSE_TAG in md
    assert "梳理高管变动" in md
    assert "Ilya Sutskever" in md
    assert "OpenAI" in md
    assert "2024年5月" in md
    assert "完成变动提取" in md
    assert "核实完毕，无争议" in md
