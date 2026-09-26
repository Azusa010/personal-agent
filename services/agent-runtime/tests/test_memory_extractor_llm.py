"""大模型记忆提炼引擎 (MemoryExtractor) 单元测试。"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from personal_agent.conversation.compression.models import DistilledFact
from personal_agent.knowledge.embedder import EmbeddingOutput
from personal_agent.knowledge.memory_extractor import (
    MemoryExtractor,
    build_memory_distill_prompt,
    is_transient_fact,
    parse_and_validate_memory_items,
)
from personal_agent.protocol.models import UserMemoryCard, UserMemoryNote


def test_build_memory_distill_prompt():
    """验证大模型提炼分级提示词结构完整、注入充分且包含双档与JSON要求。"""
    task_summary = "协助用户梳理开发配置与健康餐饮计划"
    history = (
        "用户: 我在写代码时习惯使用 TypeScript，且缩进 2 空格。\n"
        "用户: 另外顺便提醒你，我对花生严重过敏，外出就餐或叫外卖务必避开含有花生的菜品。\n"
        "用户: 昨天我们在 Docker 容器里构建 pgvector 镜像遇到网络超时，最后用了国内镜像源解决。\n"
        "Agent: 收到，所有要求均已明确并为你制定了方案。"
    )

    prompt = build_memory_distill_prompt(task_summary, history)

    # 1. 验证关键上下文完整注入
    assert task_summary in prompt
    assert "对花生严重过敏" in prompt
    assert "TypeScript" in prompt

    # 2. 验证明确定义了 card 与 note 双轨分级规范
    assert "card" in prompt
    assert "note" in prompt

    # 3. 验证对关键偏好/禁忌/身份要求归入 card
    assert any(w in prompt for w in ["偏好", "禁忌", "过敏", "身份"])

    # 4. 验证对备忘/流水/经验要求归入 note
    assert any(w in prompt for w in ["流水", "备忘", "背景", "经验", "探讨"])

    # 5. 验证输出格式被强约束为 JSON 列表并包含 entryFormat 判别字段
    assert "JSON" in prompt or "json" in prompt
    assert "entryFormat" in prompt


def test_is_transient_fact_with_jev_client():
    """验证使用 Jev (TypeSafeClient) 判定瞬时事实成功。"""
    mock_jev = MagicMock()
    mock_jev.system_one.return_value = {"is_transient": "True"}

    fact = DistilledFact(
        subject="自定义临时文件",
        predicate="位于",
        object="/var/data/custom.bin",
    )
    assert is_transient_fact(fact, client=mock_jev) is True
    mock_jev.system_one.assert_called_once()

    mock_jev.system_one.return_value = {"is_transient": "False"}
    assert is_transient_fact(fact, client=mock_jev) is False


def test_is_transient_fact_jev_fallback():
    """验证 Jev 模型异常时降级到本地关键词规则。"""
    mock_jev = MagicMock()
    mock_jev.system_one.side_effect = RuntimeError("network error")

    transient_fact = DistilledFact(
        subject="tmp_dir",
        predicate="位于",
        object="/tmp/test",
    )
    assert is_transient_fact(transient_fact, client=mock_jev) is True

    persistent_fact = DistilledFact(
        subject="用户偏好",
        predicate="喜欢",
        object="无糖咖啡",
    )
    assert is_transient_fact(persistent_fact, client=mock_jev) is False


def test_parse_and_validate_memory_items_clean():
    """验证解析标准 JSON 列表输出，正确分流生成 UserMemoryCard 与 UserMemoryNote。"""
    raw_json = json.dumps([
        {
            "entryFormat": "card",
            "memoryType": "semantic",
            "category": "preference",
            "subject": "咖啡偏好",
            "content": {"favorite": "美式", "sugar": False},
            "backstory": "用户明确声明喝咖啡不加糖",
        },
        {
            "entryFormat": "note",
            "title": "Docker 镜像配置",
            "noteText": "pgvector 镜像构建时需要使用国内镜像源避免超时。",
            "tags": ["docker", "postgres"],
        },
    ], ensure_ascii=False)

    items = parse_and_validate_memory_items(raw_json, task_id="task-clean-01")
    assert len(items) == 2

    card = items[0]
    assert isinstance(card, UserMemoryCard)
    assert card.entryFormat == "card"
    assert card.subject == "咖啡偏好"
    assert card.category == "preference"
    assert card.content == {"favorite": "美式", "sugar": False}
    assert card.sourceTaskId == "task-clean-01"
    assert card.id is not None

    note = items[1]
    assert isinstance(note, UserMemoryNote)
    assert note.entryFormat == "note"
    assert note.title == "Docker 镜像配置"
    assert "pgvector" in note.noteText
    assert "docker" in note.tags
    assert note.sourceTaskId == "task-clean-01"
    assert note.id is not None


def test_parse_and_validate_memory_items_markdown_fences_and_preamble():
    """验证从带 Markdown 代码块围栏与前后缀文本的 LLM 输出中安全提取 JSON。"""
    raw_text = (
        "您好，经过对本次任务与对话历史的深度分析，提炼出以下记忆：\n\n"
        "```json\n"
        "[\n"
        "  {\n"
        "    \"entryFormat\": \"card\",\n"
        "    \"subject\": \"快捷键偏好\",\n"
        "    \"content\": {\"editor\": \"vscode\", \"keybinding\": \"vim\"}\n"
        "  },\n"
        "  {\n"
        "    \"entryFormat\": \"note\",\n"
        "    \"title\": \"网络排查笔记\",\n"
        "    \"noteText\": \"遇到代理超时请检查 HTTP_PROXY 环境变量。\",\n"
        "    \"tags\": [\"network\", \"proxy\"]\n"
        "  }\n"
        "]\n"
        "```\n\n"
        "以上两项已归入记忆系统，请查阅。"
    )

    items = parse_and_validate_memory_items(raw_text, task_id="task-fences-02")
    assert len(items) == 2
    assert isinstance(items[0], UserMemoryCard)
    assert items[0].subject == "快捷键偏好"
    assert isinstance(items[1], UserMemoryNote)
    assert items[1].title == "网络排查笔记"


def test_parse_and_validate_memory_items_malformed_and_partial_failure():
    """验证畸形输出安全降级 (fail-closed) 以及部分项损坏时的安全跳过机制。"""
    # 1. 彻底非 JSON：安全返回空列表，不崩溃
    assert parse_and_validate_memory_items("我无法提炼出任何记忆。") == []
    assert parse_and_validate_memory_items("{'invalid': 'json'}") == []
    assert parse_and_validate_memory_items("") == []

    # 2. 混合数组：包含 1 条有效 Card、1 条损坏项（非 dict）、1 条有效 Note
    mixed_raw = json.dumps([
        {
            "entryFormat": "card",
            "subject": "代码缩进",
            "content": {"indent": 2},
        },
        "bad string item",
        {"entryFormat": "invalid_format", "something": 123},
        {
            "entryFormat": "note",
            "title": "备忘录",
            "noteText": "周五下午进行系统上线演练。",
        },
    ], ensure_ascii=False)

    items = parse_and_validate_memory_items(mixed_raw, task_id="task-mix-03")
    assert len(items) == 2
    assert isinstance(items[0], UserMemoryCard)
    assert items[0].subject == "代码缩进"
    assert isinstance(items[1], UserMemoryNote)
    assert items[1].title == "备忘录"


def test_parse_and_validate_memory_items_pii_sanitization():
    """验证提炼记忆中的敏感信息（手机号、身份证、银行卡）被本地确定性脱敏。"""
    pii_raw = json.dumps([
        {
            "entryFormat": "card",
            "subject": "用户联系方式",
            "content": {"phone": "13912345678", "idCard": "11010119900307239X"},
        },
        {
            "entryFormat": "note",
            "title": "财务账户备忘",
            "noteText": "报销收款卡号为 6222021234567890123，手机 13800000000。",
        },
    ], ensure_ascii=False)

    items = parse_and_validate_memory_items(pii_raw, task_id="task-pii-04")
    assert len(items) == 2

    card = items[0]
    assert isinstance(card, UserMemoryCard)
    assert card.isSanitized is True
    assert "139****5678" in str(card.content)
    assert "11010119900307239X" not in str(card.content)

    note = items[1]
    assert isinstance(note, UserMemoryNote)
    assert note.isSanitized is True
    assert "138****0000" in note.noteText
    assert "[REDACTED_CARD]" in note.noteText


def test_distill_from_history_pipeline():
    """验证 distill_from_history 完整管道：Prompt 装配 -> LLM 调用 -> 容错解析 -> 嵌入 -> 纯追加持久化。"""
    mock_pool = MagicMock()
    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = "550e8400-e29b-41d4-a716-446655440000"
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn

    mock_embedder = AsyncMock()
    mock_embedder.embed_query.return_value = EmbeddingOutput(
        dense=[0.05] * 1024,
        sparse={"memory": 1.0},
    )

    mock_llm_client = MagicMock()
    mock_message = MagicMock()
    mock_message.content = json.dumps([
        {
            "entryFormat": "card",
            "memoryType": "semantic",
            "category": "preference",
            "subject": "咖啡偏好",
            "content": {"favorite": "拿铁", "sugar": False},
        },
        {
            "entryFormat": "note",
            "title": "调试经验",
            "noteText": "遇到网络波动时重试三次可解决问题。",
            "tags": ["debug", "network"],
        },
    ], ensure_ascii=False)
    mock_choice = MagicMock()
    mock_choice.message = mock_message
    mock_completion = MagicMock()
    mock_completion.choices = [mock_choice]
    mock_llm_client.chat.completions.create.return_value = mock_completion

    extractor = MemoryExtractor(
        pool=mock_pool,
        embedder=mock_embedder,
        client=mock_llm_client,
    )

    async def _run():
        items = await extractor.distill_from_history(
            task_id="task-hist-001",
            task_summary="调试与餐饮讨论",
            history="用户: 我喜欢无糖拿铁\n用户: 昨晚网络超时重试三次成功了",
        )
        assert len(items) == 2
        assert mock_conn.fetchval.call_count == 2
        assert mock_embedder.embed_query.call_count == 2

    asyncio.run(_run())
