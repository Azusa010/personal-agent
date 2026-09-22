"""状态栏安全修剪器（Pruner）：谨慎删除上下文，捍卫工具配对不变量。"""
from collections import deque
from typing import Any

from personal_agent.conversation.status.renderer import (
    STATUS_BAR_CLOSE_TAG,
    STATUS_BAR_OPEN_TAG,
)


def is_status_bar_message(message: dict[str, Any]) -> bool:
    """判定某条消息是否为状态栏消息。

    标准判据：
    - 消息角色为 "user" 或 "system"；
    - content 为字符串且包含 <status_bar> 标记；
    - 绝不可能是包含 tool_calls 的 assistant 消息，也绝不可能是 role="tool" 消息。
    """
    role = message.get("role")
    if role not in ("user", "system"):
        return False

    content = message.get("content")
    if not isinstance(content, str):
        return False

    return STATUS_BAR_OPEN_TAG in content and STATUS_BAR_CLOSE_TAG in content


class ContextInvariantViolation(Exception):
    """上下文协议不变量破坏异常（如 tool_calls 悬空或丢失配对）。"""



def safe_prune_status_bars(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """安全修剪消息序列中的所有历史状态栏消息，并捍卫工具调用配对不变量。
    """
    cleaned = [msg for msg in messages if not is_status_bar_message(msg)]

    # 2. 待销账的 tool_call_id 队列
    pending_ids: deque[str] = deque()
    for msg in cleaned:
        role = msg.get("role")
        if pending_ids:
            # 还有待销账的 id 时，当前紧跟的这一条必须是匹配的 tool
            expected_id = pending_ids.popleft()
            if role != "tool" or msg.get("tool_call_id") != expected_id:
                raise ContextInvariantViolation("工具调用配对不变量破坏")
        elif role == "assistant" and msg.get("tool_calls"):
            # assistant 提出了新的工具调用，把待销账的所有 id 存入队列（兼容并行 1:N）
            for call in msg["tool_calls"]:
                pending_ids.append(call["id"])
        elif role == "tool":
            # 没有任何待销账项，却冒出一个孤立的 tool
            raise ContextInvariantViolation("工具调用配对不变量破坏")
    if pending_ids:
        # 遍历完还有没销账的 id（即 tool_calls 悬空了）
        raise ContextInvariantViolation("工具调用配对不变量破坏")
    return cleaned