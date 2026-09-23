"""单元测试：基于 tiktoken 的 Token 计量工具。"""

from personal_agent.conversation.compression.tokens import (
    count_tokens,
)


def test_count_tokens_empty():
    assert count_tokens("") == 0


def test_count_tokens_english_and_chinese():
    # 英文
    assert count_tokens("hello world") == 2
    # 中文
    assert count_tokens("你好世界") > 0
    # 混合代码与 JSON
    json_text = '{"name": "Alice", "action": "test"}'
    assert count_tokens(json_text) > 0


def test_count_tokens_special_tokens_safe():
    # 验证遇到诸如 <|endoftext|> 这类特殊 token 字符串时不会报 ValueError
    assert count_tokens("some text with <|endoftext|> in it") > 0
