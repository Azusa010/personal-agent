"""阶段 4 端到端集成测试：上下文压缩、工作文档注入与模型消息装配。"""



from personal_agent.conversation.compression.document import (
    DOCUMENT_CLOSE_TAG,
    DOCUMENT_OPEN_TAG,
)
from personal_agent.conversation.context.manager import ContextManager
from personal_agent.conversation.model.gateway import ModelContext, Observation
from personal_agent.conversation.model.live_model import render_input, render_messages


def test_context_manager_under_threshold_preserves_raw_observations():
    """正常水位下（未触达 75% 警戒阈值），保留原始工具返回，不产生额外工作文档。"""
    cm = ContextManager(
        task_goal="清理目录",
        max_window_tokens=8000,
    )
    obs = Observation(
        callId="call-1",
        capability="filesystem_list",
        ok=True,
        payload={"files": ["a.txt", "b.txt"]},
    )
    cm.record(obs)

    ctx = cm.build(taskGoal="清理目录", visibleCapabilities=["filesystem_list"])
    assert ctx.progressDocument is None
    assert ctx.observations[0].payload == {"files": ["a.txt", "b.txt"]}
    assert ctx.observations[0].callId == "call-1"


def test_context_manager_over_threshold_triggers_distillation_and_progress_document():
    """触达主 Agent 窗口负载率阈值时，自动触发较早观察提炼与工作文档挂载。"""
    # 设定较小的窗口上限 100 tokens，75% 阈值为 75 tokens（当前测试数据约 120 tokens）
    cm = ContextManager(
        task_goal="提取公司人事变动",
        max_window_tokens=100,
    )

    # 1. 早期工具观察（体量较大，应被提炼）
    obs_early = Observation(
        callId="call-1",
        capability="filesystem_create_dir",
        ok=True,
        payload={"created": True, "path": "/test/directory/archive/" + "x" * 700},
    )
    # 2. 最近活跃工具观察（应被保留不压缩）
    obs_recent = Observation(
        callId="call-2",
        capability="filesystem_move",
        ok=True,
        payload={"moved": True, "source": "a", "target": "b"},
    )
    cm.record(obs_early)
    cm.record(obs_recent)

    ctx = cm.build(
        taskGoal="提取公司人事变动",
        visibleCapabilities=["filesystem_create_dir", "filesystem_move"],
    )

    # 验证较早的 obs_early 被提炼，且 callId 严格继承
    assert ctx.observations[0].callId == "call-1"
    assert ctx.observations[0].payload.get("distilled") is True
    assert "filesystem_create_dir" in ctx.observations[0].payload.get("summary", "")

    # 验证最近的 obs_recent 保持原始未压缩
    assert ctx.observations[1].callId == "call-2"
    assert ctx.observations[1].payload == {"moved": True, "source": "a", "target": "b"}

    # 验证工作文档已成功挂载并包含执行里程碑
    assert ctx.progressDocument is not None
    assert DOCUMENT_OPEN_TAG in ctx.progressDocument
    assert DOCUMENT_CLOSE_TAG in ctx.progressDocument
    assert "filesystem_create_dir" in ctx.progressDocument


def test_live_model_render_messages_mounts_progress_document():
    """验证 LiveModel.render_messages 将工作文档注入用户消息，并维护工具配对不变量。"""
    doc_text = f"{DOCUMENT_OPEN_TAG}\n# 认知工作台\n- [2024年5月] Ilya Sutskever 离开 OpenAI\n{DOCUMENT_CLOSE_TAG}"
    ctx = ModelContext(
        taskGoal="高管调查",
        visibleCapabilities=["document_extract_pdf"],
        observations=[
            Observation(
                callId="call-10",
                capability="document_extract_pdf",
                ok=True,
                payload={"summary": "提取到离职信息", "distilled": True},
                arguments={"path": "a.pdf"},
            )
        ],
        progressDocument=doc_text,
    )

    messages = render_messages(ctx)

    # 1. 验证用户消息包含了工作文档
    user_msg = next(m for m in messages if m["role"] == "user")
    assert DOCUMENT_OPEN_TAG in user_msg["content"]
    assert "Ilya Sutskever 离开 OpenAI" in user_msg["content"]

    # 2. 验证工具调用配对未被破坏
    assistant_msg = next(m for m in messages if m["role"] == "assistant")
    tool_msg = next(m for m in messages if m["role"] == "tool")
    assert assistant_msg["tool_calls"][0]["id"] == "call-10"
    assert tool_msg["tool_call_id"] == "call-10"
    assert "提取到离职信息" in tool_msg["content"]


def test_live_model_render_input_includes_progress_document():
    """向后兼容：验证 Responses API 纯文本单段 Prompt 也包含了工作文档。"""
    doc_text = f"{DOCUMENT_OPEN_TAG}\n# 认知工作台\n- 关键进展已记录\n{DOCUMENT_CLOSE_TAG}"
    ctx = ModelContext(
        taskGoal="整理名单",
        progressDocument=doc_text,
    )
    rendered = render_input(ctx)
    assert DOCUMENT_OPEN_TAG in rendered
    assert "关键进展已记录" in rendered
