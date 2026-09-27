"""Sidecar 请求拦截与记忆预检索单元测试。"""

from unittest.mock import AsyncMock, MagicMock

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.model.gateway import ModelContext
from personal_agent.conversation.model.live_model import render_messages
from personal_agent.conversation.model.live_planner import render_plan_input
from personal_agent.conversation.sidecar import (
    enrich_query_memories,
    format_memory_entry,
    intercept_query_memories,
)
from personal_agent.protocol.models import (
    PlanStepDto,
    UserMemoryCard,
    UserMemorySearchItem,
    UserMemorySearchResult,
)


def test_format_memory_entry_dict_content():
    """验证 UserMemoryCard 格式化为易读的文本提示词条目。"""
    card = UserMemoryCard(
        id="c-1",
        memoryType="semantic",
        category="preference",
        subject="缩进风格",
        content={"indent": "2 spaces", "tab": False},
        person="本人",
        validFrom="2026-09-20T00:00:00Z",
        createdAt="2026-09-20T00:00:00Z",
        updatedAt="2026-09-20T00:00:00Z",
    )
    line = format_memory_entry(card)
    # TODO(你填)[验证与质量]: 断言 —— 期望：格式化后的条目应映射出 [个人偏好] 标签，且包含主题 '缩进风格' 与缩进内容
    assert "[个人偏好]" in line
    assert "缩进风格" in line
    assert "indent: 2 spaces" in line
    assert "关联人" not in line


def test_format_memory_entry_with_other_person():
    """验证非本人的记忆条目正确附加关联人后缀。"""
    card = UserMemoryCard(
        id="c-2",
        memoryType="semantic",
        category="routine",
        subject="周会汇报",
        content={"detail": "每周一上午需向组长汇报进度"},
        person="张三",
        validFrom="2026-09-20T00:00:00Z",
        createdAt="2026-09-20T00:00:00Z",
        updatedAt="2026-09-20T00:00:00Z",
    )
    line = format_memory_entry(card)
    assert "[流程惯例]" in line
    assert "周会汇报" in line
    assert "(关联人: 张三)" in line


def test_intercept_query_memories_success():
    """验证用户发送 query 时，Sidecar 拦截请求并成功检索格式化相关记忆。"""
    mock_card = UserMemoryCard(
        id="c-3",
        memoryType="semantic",
        category="preference",
        subject="测试框架",
        content={"framework": "Vitest"},
        validFrom="2026-09-20T00:00:00Z",
        createdAt="2026-09-20T00:00:00Z",
        updatedAt="2026-09-20T00:00:00Z",
    )
    mock_result = UserMemorySearchResult(
        ok=True,
        query="编写单元测试",
        totalFound=1,
        items=[
            UserMemorySearchItem(
                card=mock_card,
                score=0.92,
                denseRank=1,
                sparseRank=1,
                matchedText="测试框架: Vitest",
            )
        ],
    )
    mock_retriever = MagicMock()
    mock_retriever.search = AsyncMock(return_value=mock_result)

    memories = intercept_query_memories("请帮我编写单元测试", retriever=mock_retriever)
    assert len(memories) == 1
    assert "[个人偏好] 测试框架" in memories[0]
    assert "framework: Vitest" in memories[0]


def test_intercept_query_memories_fallback_on_exception():
    """验证当检索抛出异常（如数据库未连通）时，优雅兜底降级为空列表。"""
    failing_retriever = MagicMock()
    failing_retriever.search = AsyncMock(side_effect=RuntimeError("PG connection lost"))

    memories = intercept_query_memories("查询一些偏好", retriever=failing_retriever)
    assert memories == []


def test_intercept_query_memories_empty_query():
    """验证空 Query 直接返回空列表。"""
    assert intercept_query_memories("") == []
    assert intercept_query_memories("   ") == []


def test_context_manager_stores_and_builds_user_memories():
    """验证 ContextManager 妥善保存并装配 userMemories 到 ModelContext。"""
    memories = ["[个人偏好] 缩进: 2个空格", "[流程惯例] 测试用 Vitest"]
    cm = ContextManager(user_memories=memories)
    assert cm.user_memories == memories

    # 支持动态更新
    cm.set_user_memories(["[个人偏好] 新偏好"])
    ctx = cm.build(taskGoal="测试任务", visibleCapabilities=[])
    assert ctx.userMemories == ["[个人偏好] 新偏好"]


def test_live_model_render_messages_includes_user_memories():
    """验证 LiveModel 渲染消息时，用户记忆与偏好被并包渲染至本轮上下文。"""
    ctx = ModelContext(
        taskGoal="重构组件",
        userMemories=["[个人偏好] 缩进风格: 2个空格"],
        plan=[PlanStepDto(description="步骤1")],
    )
    messages = render_messages(ctx)
    user_msg = next(m for m in messages if m["role"] == "user")
    assert "任务目标：重构组件" in user_msg["content"]
    assert "【相关用户记忆与偏好】" in user_msg["content"]
    assert "- [个人偏好] 缩进风格: 2个空格" in user_msg["content"]


def test_live_planner_render_plan_input_includes_user_memories():
    """验证 LivePlanner 渲染计划输入时，携带用户记忆与偏好。"""
    memories = ["[流程惯例] 必须使用 Vitest"]
    text = render_plan_input(
        goal="编写测试",
        visibleCapabilities=[],
        user_memories=memories,
    )
    assert "目标：编写测试" in text
    assert "【相关用户记忆与偏好】" in text
    assert "- [流程惯例] 必须使用 Vitest" in text


def test_enrich_query_memories_calls_filter_relevant_memories_with_jev():
    """验证 enrich_query_memories 显式调用 filter_relevant_memories 进行 Jev 决策打分并剔除噪音。"""
    candidates = [
        {"id": "m-gold", "content": "用户代码偏好使用 Vitest 测试框架"},
        {"id": "m-noise", "content": "用户喜欢在工作日下班后去健身房跑步"},
    ]
    mock_client = MagicMock()
    mock_resp = MagicMock()
    # m-gold: 约束/偏好 (高分)
    r0, i0, c0 = MagicMock(), MagicMock(), MagicMock()
    r0.noul, i0.score, c0.choice = 0.95, 3.8, "preference"
    # m-noise: 噪音 (0分)
    r1, i1, c1 = MagicMock(), MagicMock(), MagicMock()
    r1.noul, i1.score, c1.choice = 0.05, 0.0, "noise"
    mock_resp.answers = {
        "rel_0": r0,
        "imp_0": i0,
        "role_0": c0,
        "rel_1": r1,
        "imp_1": i1,
        "role_1": c1,
    }
    mock_client.system_one.return_value = mock_resp

    memories = enrich_query_memories(
        query="编写单元测试",
        candidates=candidates,
        client=mock_client,
    )
    # 验证经过 filter_relevant_memories 过滤后，只保留 m-gold，噪音 m-noise 被剔除
    assert len(memories) == 1
    assert "Vitest" in memories[0]
    assert "健身房" not in memories[0]

