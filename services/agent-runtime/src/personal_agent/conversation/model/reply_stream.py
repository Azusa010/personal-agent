"""从流式到达的 finish_task arguments JSON 中增量提取 reply 字段的已到达文本。

正文（reply）随 finish_task 的 arguments 逐 token 上线，但 arguments 是一截
不完整的 JSON。这里用一个单遍状态机从 buffer 里抽出 "reply" 值字符串的已解码
前缀：key 字符串必须完整闭合且后跟冒号才确认（防其他字段内容恰好叫 reply 的
假阳性），值字符串边到边解码转义；尾部落在不完整转义序列（如单独的 \\ 或
\\u0）时停在前一个安全点，等下一轮 delta 补齐。

调用方每收到一段 arguments delta 就对全量 buffer 重扫一次（reply 通常几十 KB，
O(n) 重扫足够便宜），拿解码结果与上次已发长度做差得到本轮增量。
"""

from __future__ import annotations

_SIMPLE_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}
_JSON_WS = " \t\r\n"


def extract_streamed_reply(partial_json: str) -> str:
    """返回 partial_json 中 reply 字段的已到达已解码前缀；还没到 reply 就返回空串。"""
    i, n = 0, len(partial_json)
    while i < n:
        if partial_json[i] != '"':
            i += 1
            continue
        # 读一个完整字符串（key 或普通字符串值）；闭合不了说明 reply 还没上屏
        j = i + 1
        parts: list[str] = []
        while True:
            if j >= n:
                return ""
            c = partial_json[j]
            if c == "\\":
                parts.append(partial_json[j : j + 2])
                j += 2
                continue
            if c == '"':
                break
            parts.append(c)
            j += 1
        if "".join(parts) == "reply":
            k = _skip_ws(partial_json, j + 1)
            # 后面必须紧跟冒号才认；否则是内容里恰好出现 "reply" 的假阳性
            if k >= n or partial_json[k] != ":":
                i = k
                continue
            k = _skip_ws(partial_json, k + 1)
            if k >= n or partial_json[k] != '"':
                return ""
            return _decode_value_string(partial_json, k + 1)
        i = j + 1
    return ""


def _skip_ws(text: str, i: int) -> int:
    n = len(text)
    while i < n and text[i] in _JSON_WS:
        i += 1
    return i


def _decode_value_string(text: str, i: int) -> str:
    """从值字符串开引号之后一位开始解码，直到未转义闭引号或 buffer 尾。"""
    out: list[str] = []
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"':
            break
        if c == "\\":
            if i + 1 >= n:
                break  # 转义符孤悬在尾部，等下一轮
            e = text[i + 1]
            if e == "u":
                if i + 6 > n:
                    break  # \\u 后 hex 不齐，等下一轮
                code = int(text[i + 2 : i + 6], 16)
                if 0xD800 <= code <= 0xDBFF:
                    # 高代理：等配对的低代理（\ud83d\ude00 这类 emoji 代理对）
                    if i + 12 > n or text[i + 6 : i + 8] != "\\u":
                        break
                    low = int(text[i + 8 : i + 12], 16)
                    if not 0xDC00 <= low <= 0xDFFF:
                        break
                    out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                    i += 12
                    continue
                out.append(chr(code))
                i += 6
                continue
            mapped = _SIMPLE_ESCAPES.get(e)
            if mapped is None:
                # 非法转义按原样放行后一个字符，防止卡死在坏输出上
                out.append(e)
            else:
                out.append(mapped)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)
