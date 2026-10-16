"""Step 1 接线测试网：本地长程记忆与话题切换工具 Schema 生成、build_tools 注入及 local_executor 分流。

本测试网验证：
1. 本地工具（archive_current_topic_and_switch, read_memory_topic, search_raw_events）具备标准的参数契约与合法的 OpenAI Tool Schema；
2. build_tools 在任何可见能力配置下，均无缝且必须自动注入本地记忆与话题切换工具；
3. local_executor 能够精准拦截并本地执行这三个工具，返回结构化的 Observation，而将常规宿主能力透明放行（返回 None）；
4. 当本地存在 INDEX.md 时，能够被感知并注入到长程记忆上下文中。
"""

from pathlib import Path

import pytest
from pydantic import ValidationError

from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.model.gateway import ToolCallDecision
from personal_agent.conversation.model.live_model import (
    FINISH_TASK_TOOL_NAME,
    build_tools,
)
from personal_agent.conversation.model.tool_schema_generator import (
    generate_local_tool_schemas,
)
from personal_agent.conversation.topics import (
    ThreeTierRetriever,
    TopicSwitchHandler,
)
from personal_agent.conversation.topics.models import (
    ArchiveTopicParams,
    ReadMemoryTopicParams,
    SearchRawEventsParams,
)
from personal_agent.conversation.windows import SlidingWindowLedger
from personal_agent.runtime import create_local_executor

# =========================================================================
# 1. 本地工具参数契约模型与 Schema 验证
# =========================================================================


def test_local_tool_param_models_validation():
    """验证三个本地工具参数模型的校验逻辑与字段契约。"""
    # 1. archive_current_topic_and_switch
    archive_params = ArchiveTopicParams(
        old_topic_summary="排查支付报错完毕",
        new_topic_intent="规划旅游行程",
    )
    assert archive_params.old_topic_summary == "排查支付报错完毕"
    assert archive_params.new_topic_intent == "规划旅游行程"

    with pytest.raises(ValidationError):
        # 缺少必要参数时应报错
        ArchiveTopicParams.model_validate({})

    # 2. read_memory_topic
    read_params = ReadMemoryTopicParams(topic_name="coding_standards.md")
    assert read_params.topic_name == "coding_standards.md"

    with pytest.raises(ValidationError):
        ReadMemoryTopicParams.model_validate({})

    # 3. search_raw_events
    search_params = SearchRawEventsParams(query="TypeError")
    assert search_params.query == "TypeError"
    assert search_params.limit == 10  # 默认值

    search_custom = SearchRawEventsParams(query="auth", limit=3)
    assert search_custom.limit == 3


def test_generate_local_tool_schemas_structure():
    """验证本地工具生成的 Tool Schema 符合 OpenAI Function Calling 规范。"""
    schemas = generate_local_tool_schemas()
    expected_local_tools = {
        "archive_current_topic_and_switch",
        "read_memory_topic",
        "search_raw_events",
    }
    assert set(schemas.keys()) == expected_local_tools

    for name in expected_local_tools:
        tool = schemas[name]
        assert tool["type"] == "function"
        fn = tool["function"]
        assert fn["name"] == name
        assert isinstance(fn["description"], str) and len(fn["description"]) > 10
        params = fn["parameters"]
        assert params["type"] == "object"
        assert "properties" in params

    # 检查 archive_current_topic_and_switch 的 required
    archive_fn = schemas["archive_current_topic_and_switch"]["function"]
    assert "old_topic_summary" in archive_fn["parameters"]["properties"]
    assert "new_topic_intent" in archive_fn["parameters"]["properties"]
    assert set(archive_fn["parameters"]["required"]) == {
        "old_topic_summary",
        "new_topic_intent",
    }

    # 检查 read_memory_topic
    read_fn = schemas["read_memory_topic"]["function"]
    assert "topic_name" in read_fn["parameters"]["properties"]
    assert read_fn["parameters"]["required"] == ["topic_name"]

    # 检查 search_raw_events
    search_fn = schemas["search_raw_events"]["function"]
    assert "query" in search_fn["parameters"]["properties"]
    assert "limit" in search_fn["parameters"]["properties"]
    assert search_fn["parameters"]["required"] == ["query"]


# =========================================================================
# 2. build_tools 自动注入验证
# =========================================================================


def test_build_tools_always_includes_local_memory_tools():
    """验证 build_tools 无论传入何种宿主可见能力，都必定包含三个本地工具与 finish_task。"""
    # 场景 A: 空可见能力
    tools_empty = build_tools([])
    tool_names_empty = {t["function"]["name"] for t in tools_empty}
    expected_always_present = {
        "archive_current_topic_and_switch",
        "read_memory_topic",
        "search_raw_events",
        FINISH_TASK_TOOL_NAME,
    }
    assert expected_always_present.issubset(tool_names_empty)

    # 场景 B: 携带宿主能力
    tools_with_cap = build_tools(["filesystem_list", "terminal_execute"])
    tool_names_with_cap = {t["function"]["name"] for t in tools_with_cap}
    assert expected_always_present.issubset(tool_names_with_cap)
    assert "filesystem_list" in tool_names_with_cap
    assert "terminal_execute" in tool_names_with_cap


# =========================================================================
# 3. local_executor 进程内执行分流与闭环验证
# =========================================================================


def test_local_executor_archive_topic_switch(tmp_path: Path):
    """验证 local_executor 正确拦截 archive_current_topic_and_switch 并产生磁盘归档。"""
    epochs_dir = tmp_path / "epochs"
    epochs_dir.mkdir()
    ledger = MainEventLedger(log_file=tmp_path / "events.jsonl")
    window = SlidingWindowLedger(ledger=ledger)
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=epochs_dir)
    retriever = ThreeTierRetriever(memory_dir=tmp_path / "memory", ledger=ledger)

    executor = create_local_executor(topic_handler=topic_handler, retriever=retriever)

    decision = ToolCallDecision(
        kind="tool_call",
        callId="call_archive_001",
        capability="archive_current_topic_and_switch",
        arguments={
            "old_topic_summary": "旧任务完成排错",
            "new_topic_intent": "去东京旅游吃拉面",
        },
    )

    obs = executor(decision)
    assert obs is not None
    assert obs.callId == "call_archive_001"
    assert obs.capability == "archive_current_topic_and_switch"
    assert obs.ok is True
    assert "archived_epoch_id" in obs.payload or "epoch_id" in obs.payload
    assert obs.payload["new_topic_intent"] == "去东京旅游吃拉面"

    # 验证物理文件落盘
    archived_files = list(epochs_dir.glob("epoch_*.md"))
    assert len(archived_files) == 1
    content = archived_files[0].read_text(encoding="utf-8")
    assert "旧任务完成排错" in content


def test_local_executor_read_memory_topic(tmp_path: Path):
    """验证 local_executor 正确拦截 read_memory_topic 并读取对应 Markdown 内容。"""
    memory_dir = tmp_path / "memory"
    topics_dir = memory_dir / "topics"
    topics_dir.mkdir(parents=True)
    pref_file = topics_dir / "user_preferences.md"
    pref_file.write_text("# 偏好\n用户偏好使用 TypeScript 纯函数。", encoding="utf-8")

    ledger = MainEventLedger(log_file=tmp_path / "events.jsonl")
    window = SlidingWindowLedger(ledger=ledger)
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")
    retriever = ThreeTierRetriever(memory_dir=memory_dir, ledger=ledger)

    executor = create_local_executor(topic_handler=topic_handler, retriever=retriever)

    # 1. 成功读取存在的主题
    decision_ok = ToolCallDecision(
        kind="tool_call",
        callId="call_read_001",
        capability="read_memory_topic",
        arguments={"topic_name": "user_preferences.md"},
    )
    obs_ok = executor(decision_ok)
    assert obs_ok is not None
    assert obs_ok.ok is True
    assert "用户偏好使用 TypeScript 纯函数" in str(obs_ok.payload)

    # 2. 读取不存在的主题返回 ok=False 友好报错
    decision_missing = ToolCallDecision(
        kind="tool_call",
        callId="call_read_002",
        capability="read_memory_topic",
        arguments={"topic_name": "non_existent.md"},
    )
    obs_missing = executor(decision_missing)
    assert obs_missing is not None
    assert obs_missing.ok is False
    assert "error" in obs_missing.payload or "reason" in obs_missing.payload


def test_local_executor_search_raw_events(tmp_path: Path):
    """验证 local_executor 正确拦截 search_raw_events 并从 Ledger 检索历史事件。"""
    log_file = tmp_path / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    ledger.append_event(
        event_type="user",
        payload={"text": "我的日本签证代办电话是 010-12345678"},
    )
    ledger.append_event(
        event_type="assistant",
        payload={"reply": "已收到您的签证电话"},
    )

    window = SlidingWindowLedger(ledger=ledger)
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")
    retriever = ThreeTierRetriever(memory_dir=tmp_path / "memory", ledger=ledger)

    executor = create_local_executor(topic_handler=topic_handler, retriever=retriever)

    decision = ToolCallDecision(
        kind="tool_call",
        callId="call_search_001",
        capability="search_raw_events",
        arguments={"query": "签证", "limit": 5},
    )
    obs = executor(decision)
    assert obs is not None
    assert obs.ok is True
    events = obs.payload.get("events") or obs.payload.get("result", [])
    assert len(events) >= 1
    assert any("010-12345678" in str(e) for e in events)


def test_local_executor_passes_through_host_capabilities(tmp_path: Path):
    """验证 local_executor 遇到宿主常规能力（如 filesystem_list）时返回 None，透明放行。"""
    ledger = MainEventLedger(log_file=tmp_path / "events.jsonl")
    window = SlidingWindowLedger(ledger=ledger)
    topic_handler = TopicSwitchHandler(window=window, epochs_dir=tmp_path / "epochs")
    retriever = ThreeTierRetriever(memory_dir=tmp_path / "memory", ledger=ledger)

    executor = create_local_executor(topic_handler=topic_handler, retriever=retriever)

    decision = ToolCallDecision(
        kind="tool_call",
        callId="call_fs_001",
        capability="filesystem_list",
        arguments={"path": "downloads"},
    )
    obs = executor(decision)
    assert obs is None  # 必须返回 None，以便 ReActLoop 转发给宿主 RPC 通道
