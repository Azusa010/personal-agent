"""Step 2 测试网：基于大模型的冷记忆提炼、做梦归并函数实现与任务结束流水线接线。

本测试网验证：
1. llm_extract_memory_events: 给定 LedgerEvent 列表，能组装 Prompt 并调用 ModelGateway，将模型输出解析为 CandidateMemoryItem 列表，支持有效偏好提取与 NO_OP 过滤；
2. llm_consolidate_topic: 给定分类、现有 Markdown 内容及新增条目，能组装 Prompt 并调用 ModelGateway 产出合并去重后的新 Markdown 内容；
3. trigger_memory_pipeline: 在任务结束或后台调度时，能一键自动衔接 Extractor.drain_all() 与 DreamEngine.run_dream()，完成全自动闭环；
4. runtime 启动时，若存在 memory/INDEX.md，其内容被自动注入到系统的常驻记忆上下文中。
"""

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from personal_agent.conversation.dream import DreamEngine
from personal_agent.conversation.extractor import (
    CandidateMemoryItem,
    ColdMemoryExtractor,
    ExtractorCursor,
    MemoryInbox,
)
from personal_agent.conversation.extractor.llm_extractor import (
    create_llm_memory_extractor,
)
from personal_agent.conversation.dream.llm_consolidator import (
    create_llm_dream_consolidator,
)
from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelDecision,
    ModelGateway,
    SummaryDecision,
)
from personal_agent.conversation.pipeline import run_task_memory_pipeline
from personal_agent.conversation.topics import ThreeTierRetriever


# =========================================================================
# Mock 辅助
# =========================================================================


class MockScriptedModel(ModelGateway):
    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.calls: list[ModelContext] = []

    def decide(self, context: ModelContext, on_thinking=None) -> ModelDecision:
        self.calls.append(context)
        resp = self.responses.pop(0) if self.responses else "{}"
        return SummaryDecision(
            kind="summary",
            reply=resp,
            facts=[],
        )


# =========================================================================
# 1. 大模型冷记忆提炼函数测试
# =========================================================================


def test_llm_extractor_extracts_user_preferences():
    """验证 create_llm_memory_extractor 组装 Prompt 调用模型，并成功将 JSON 解析为 CandidateMemoryItem。"""
    mock_json_reply = """
    [
        {
            "category": "user_preferences",
            "content": "用户偏好使用 TypeScript 编写纯函数，避免副作用",
            "confidence": 0.95,
            "action": "APPEND"
        }
    ]
    """
    model = MockScriptedModel([mock_json_reply])
    extract_fn = create_llm_memory_extractor(model)

    events = [
        LedgerEvent(
            seq_id=1,
            epoch_id=1,
            timestamp="1000",
            event_type="user",
            payload={"text": "请帮我写一个工具函数，记住我一律用 TypeScript 纯函数，不要副作用。"},
            token_count=30,
        ),
        LedgerEvent(
            seq_id=2,
            epoch_id=1,
            timestamp="2000",
            event_type="assistant",
            payload={"reply": "好的，已遵循您的偏好。"},
            token_count=15,
        ),
    ]

    items = extract_fn(events)
    assert isinstance(items, list)
    assert len(items) == 1
    assert items[0].category == "user_preferences"
    assert "TypeScript" in items[0].content
    assert items[0].confidence == 0.95
    assert items[0].action == "APPEND"

    # 验证 Prompt 确实被送给模型
    assert len(model.calls) == 1
    call_goal = model.calls[0].taskGoal
    assert "提炼" in call_goal or "记忆" in call_goal or "Memory" in call_goal


def test_llm_extractor_handles_noop_or_empty():
    """验证当模型输出 NO_OP 或空 JSON 时，提取函数安全返回空列表。"""
    mock_noop_reply = """
    [
        {
            "category": "other",
            "content": "临时编译报错排查",
            "confidence": 0.5,
            "action": "NO_OP"
        }
    ]
    """
    model = MockScriptedModel([mock_noop_reply])
    extract_fn = create_llm_memory_extractor(model)

    events = [
        LedgerEvent(
            seq_id=3,
            epoch_id=1,
            timestamp="3000",
            event_type="user",
            payload={"text": "看下这个报错是什么原因"},
            token_count=10,
        )
    ]
    items = extract_fn(events)
    assert len(items) == 0  # NO_OP 必须被过滤剔除


# =========================================================================
# 2. 大模型做梦归并函数测试
# =========================================================================


def test_llm_consolidator_merges_topic_markdown():
    """验证 create_llm_dream_consolidator 调用模型完成主题增量合并。"""
    mock_merged_markdown = """# 用户偏好与习惯

- 语言规范：必须使用 TypeScript 纯函数架构。
- 缩进约定：统一使用 2 空格缩进。
"""
    model = MockScriptedModel([mock_merged_markdown])
    consolidate_fn = create_llm_dream_consolidator(model)

    old_content = "# 用户偏好与习惯\n\n- 缩进约定：统一使用 2 空格缩进。\n"
    new_items = [
        CandidateMemoryItem(
            category="user_preferences",
            content="必须使用 TypeScript 纯函数架构",
            confidence=0.9,
            action="APPEND",
        )
    ]

    merged_text = consolidate_fn("user_preferences", old_content, new_items)
    assert isinstance(merged_text, str)
    assert "TypeScript 纯函数架构" in merged_text
    assert "2 空格缩进" in merged_text
    assert len(model.calls) == 1


# =========================================================================
# 3. 任务结束一键记忆流水线测试
# =========================================================================


def test_run_task_memory_pipeline_end_to_end(tmp_path: Path):
    """验证 run_task_memory_pipeline 能顺畅串联 Extractor 与 DreamEngine 自动完成提炼和落盘。"""
    harness_dir = tmp_path / ".my_agent_harness"
    memory_dir = harness_dir / "memory"
    logs_dir = harness_dir / "logs"
    memory_dir.mkdir(parents=True)
    logs_dir.mkdir(parents=True)

    # 1. 预先在 Ledger 写入待提炼事件
    ledger = MainEventLedger(log_file=logs_dir / "main_session_events.jsonl")
    ledger.append_event(
        event_type="user",
        payload={"text": "我平时偏好使用 Ruff 进行 Python 代码格式化。"},
    )
    ledger.append_event(
        event_type="assistant",
        payload={"reply": "已记下您的 Ruff 偏好。"},
    )

    # 2. Mock 模型同时服务提炼与做梦
    model = MockScriptedModel(
        [
            # 第一次响应：提取器输出
            """[{"category": "user_preferences", "content": "Python 偏好使用 Ruff 格式化", "confidence": 0.9, "action": "APPEND"}]""",
            # 第二次响应：做梦归并输出 Markdown
            """# 偏好\n\n- Python 偏好使用 Ruff 格式化。\n""",
        ]
    )

    # 3. 运行一键流水线
    pipeline_result = run_task_memory_pipeline(
        harness_dir=harness_dir,
        model=model,
        force_dream=True,
    )

    assert pipeline_result["extracted_items_count"] == 1
    assert pipeline_result["dream_executed"] is True

    # 验证物理文件最终落盘
    pref_file = memory_dir / "topics" / "user_preferences.md"
    assert pref_file.exists()
    assert "Ruff" in pref_file.read_text(encoding="utf-8")

    index_file = memory_dir / "INDEX.md"
    assert index_file.exists()
    assert "user_preferences" in index_file.read_text(encoding="utf-8")


# =========================================================================
# 4. 常驻 INDEX.md 自动注入测试
# =========================================================================


def test_retriever_get_system_index_content(tmp_path: Path):
    """验证 ThreeTierRetriever 正确读取常驻 INDEX.md 作为 Tier 1 索引。"""
    memory_dir = tmp_path / "memory"
    memory_dir.mkdir(parents=True)
    index_file = memory_dir / "INDEX.md"
    index_content = "# 长期记忆索引\n- [user_preferences.md](./topics/user_preferences.md): 用户偏好"
    index_file.write_text(index_content, encoding="utf-8")

    retriever = ThreeTierRetriever(memory_dir=memory_dir, ledger=None)
    read_index = retriever.get_system_index()
    assert read_index == index_content
