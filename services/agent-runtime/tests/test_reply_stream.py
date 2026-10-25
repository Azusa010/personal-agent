"""reply_stream 增量抽取的纯函数测试。

聚焦流式场景的硬边界：delta 任意切分点、JSON 转义序列被从中间劈开、
facts 先于 reply 到达、内容里恰好出现 "reply" 字样的假阳性。
"""

import pytest

from personal_agent.conversation.model.reply_stream import extract_streamed_reply

REPLY = "第一行\n带\"引号\"与反斜杠\\，还有 emoji \U0001F600 和中文。"
_FULL_VALUE = (
    '"第一行\\n带\\"引号\\"与反斜杠\\\\，还有 emoji \\ud83d\\ude00 和中文。"'
)
FULL = f'{{"kind": "summary", "reply": {_FULL_VALUE}, "facts": [{{"text": "事实", "pageRefs": [1]}}]}}'


def _assert_grows_monotonically(chunks: list[str]) -> None:
    buffer = ""
    seen = ""
    for chunk in chunks:
        buffer += chunk
        decoded = extract_streamed_reply(buffer)
        assert decoded.startswith(seen)
        assert len(decoded) >= len(seen)
        seen = decoded
    assert seen == REPLY


def test_whole_arguments_at_once():
    assert extract_streamed_reply(FULL) == REPLY


def test_reply_only():
    assert extract_streamed_reply('{"reply": "你好"}') == "你好"


def test_reply_first_field():
    assert extract_streamed_reply('{"reply": "你好", "facts": []}') == "你好"


def test_facts_before_reply():
    text = '{"facts": [{"text": "事实", "pageRefs": [1, 2]}], "reply": "结论"}'
    assert extract_streamed_reply(text) == "结论"


def test_char_by_char_split_reaches_full_text():
    _assert_grows_monotonically(list(FULL))


def test_split_inside_escape_sequence():
    # 把转义序列 \n、\"、\\uXXXX 从中间劈开，各停点都必须是安全前缀
    for cut in range(len(FULL)):
        head, tail = FULL[:cut], FULL[cut:]
        decoded_head = extract_streamed_reply(head)
        assert extract_streamed_reply(head) == decoded_head
        assert extract_streamed_reply(head + tail) == REPLY


def test_incomplete_key_and_value_return_empty():
    assert extract_streamed_reply('{"rep') == ""
    assert extract_streamed_reply('{"reply"') == ""
    assert extract_streamed_reply('{"reply":') == ""
    assert extract_streamed_reply('{"reply": "还没上屏的文') == "还没上屏的文"


def test_trailing_backslash_waits_for_next_chunk():
    assert extract_streamed_reply('{"reply": "a\\') == "a"


def test_trailing_partial_unicode_escape_waits():
    # \u 的 hex 只到了两位：解码停在安全点，不产出半个码位
    assert extract_streamed_reply('{"reply": "a\\u4e') == "a"


def test_unicode_escape_completes_across_chunks():
    buffer = '{"reply": "\\u4e'
    assert extract_streamed_reply(buffer) == ""
    decoded = extract_streamed_reply(buffer + '2d"}')
    assert decoded == "中"


def test_surrogate_pair_split_across_chunks_waits_then_combines():
    head = '{"reply": "a\\ud83d'
    # 高代理孤悬：停在它之前，不产出半个 emoji
    assert extract_streamed_reply(head) == "a"
    decoded = extract_streamed_reply(head + '\\ude00"}')
    assert decoded == "a\U0001F600"


def test_reply_word_inside_other_strings_is_ignored():
    # facts 的 text 值恰好是 "reply"（后跟逗号不是冒号），不能误认
    text = '{"facts": [{"text": "reply", "pageRefs": [1]}], "reply": "真回复"}'
    assert extract_streamed_reply(text) == "真回复"


def test_kind_summary_before_reply_does_not_confuse():
    text = '{"kind": "summary", "reply": "ok"}'
    assert extract_streamed_reply(text) == "ok"


def test_no_reply_key_returns_empty():
    assert extract_streamed_reply('{"kind": "tool_call", "capability": "file_read"}') == ""
    assert extract_streamed_reply("") == ""


def test_whitespace_between_key_and_colon():
    text = '{ "reply" : "带空格" }'
    assert extract_streamed_reply(text) == "带空格"


def test_split_inside_escape_yields_only_safe_prefix():
    # 专项钉住：劈开的转义在头部 stop 时不能产出脏字符
    head = '{"reply": "前半\\n'
    assert extract_streamed_reply(head) == "前半\n"
    assert extract_streamed_reply(head + '后半"}') == "前半\n后半"


@pytest.mark.parametrize(
    ("partial", "expected"),
    [
        ('{"reply": "tab\\tend"', "tab\tend"),
        ('{"reply": "\\/slash"', "/slash"),
        ('{"reply": "bad\\xesc"', "badxesc"),  # 非法转义放行后字符
    ],
)
def test_escape_variants(partial, expected):
    assert extract_streamed_reply(partial) == expected
