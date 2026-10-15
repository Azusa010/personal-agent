"""Token 计量工具：基于 tiktoken 实现官方精确分词与计量。"""

import logging
import os
from functools import lru_cache

import tiktoken

log = logging.getLogger("personal_agent")

DEFAULT_TOKEN_ENCODING = os.getenv("TIKTOKEN_ENCODING", "o200k_harmony")


@lru_cache(maxsize=4)
def _get_encoding(encoding_name: str | None = None) -> tiktoken.Encoding:
    name = encoding_name or os.getenv("TIKTOKEN_ENCODING", "o200k_harmony")
    try:
        return tiktoken.get_encoding(name)
    except Exception as err:  # noqa: BLE001
        log.warning("获取 tiktoken 编码器 %s 失败，回退到 cl100k_base: %s", name, err)
        return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str, encoding_name: str | None = None) -> int:
    """计算指定文本在对应模型分词器下的精确 token 数。"""
    if not text:
        return 0
    enc = _get_encoding(encoding_name)
    return len(enc.encode(text, disallowed_special=()))
