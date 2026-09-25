"""本地轻量 PII 隐私脱敏层 (Memory Sanitizer)。
"""

import copy
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# 正则表达式预编译
REGEX_PHONE = re.compile(r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)")
REGEX_ID_CARD = re.compile(
    r"(?<!\d)([1-9]\d)(?:\d{14})([\dXx])(?!\d)"
)
REGEX_BANK_CARD = re.compile(r"(?<!\d)(?:[4-6]\d{15,18})(?!\d)")
REGEX_SECRET = re.compile(
    r"""(?i)(password|secret|token|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?([^\s"',;]{8,})["']?"""
)


def mask_string_pii(text: str) -> tuple[str, bool]:
    """对单段文本执行 PII 确定性脱敏。

    返回: (脱敏后文本, 是否发生了脱敏)
    """
    if not text or not isinstance(text, str):
        return text, False

    original = text
    modified = text

    # 1. 手机号脱敏：13812345678 -> 138****5678
    modified = REGEX_PHONE.sub(r"\1****\3", modified)

    # 2. 身份证号脱敏：前 2 位与末位保留，中间加 ****
    modified = REGEX_ID_CARD.sub(r"\1****\2", modified)

    # 3. 银行卡脱敏：替换为 [REDACTED_CARD]
    modified = REGEX_BANK_CARD.sub("[REDACTED_CARD]", modified)

    # 4. 敏感凭证脱敏：键名保留，凭证值替换为 [REDACTED_SECRET]
    modified = REGEX_SECRET.sub(r"\1=[REDACTED_SECRET]", modified)

    has_changed = modified != original
    return modified, has_changed

# 这里后续可以接入本地模型
def sanitize_memory_data(data: Any) -> tuple[Any, bool]:
    """递归遍历任意数据结构（dict / list / str 等），执行 PII 脱敏过滤。
    """
    if data is None or isinstance(data, (int, float, bool)):
        return data, False

    if isinstance(data, str):
        return mask_string_pii(data)
    try:
        if isinstance(data, dict):
            new_dict = {}
            any_sanitized = False
            for k, v in data.items():
                sanitized_k, k_changed = mask_string_pii(str(k))
                sanitized_v, v_changed = sanitize_memory_data(v)
                new_dict[sanitized_k] = sanitized_v
                if k_changed or v_changed:
                    any_sanitized = True
            return new_dict, any_sanitized

        if isinstance(data, list):
            new_list = []
            any_sanitized = False
            for item in data:
                sanitized_item, item_changed = sanitize_memory_data(item)
                new_list.append(sanitized_item)
                if item_changed:
                    any_sanitized = True
            return new_list, any_sanitized

        return copy.deepcopy(data), False
    except Exception as e:  # noqa: BLE001
        logger.error(f"[memory_sanitizer] 脱敏递归异常，执行 fail-closed 兜底: {e}")
        # fail-closed 兜底
        fallback_str, _ = mask_string_pii(str(data))
        return fallback_str, True
