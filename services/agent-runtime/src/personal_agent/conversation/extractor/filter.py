import re

from personal_agent.conversation.ledger import LedgerEvent

CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```")
TRIVIAL_REPLIES = {
    "继续",
    "好的",
    "好",
    "行",
    "可以",
    "ok",
    "okay",
    "yes",
    "y",
    "再来",
    "报错了",
    "不对",
    "重试",
    "看下",
    "谢谢",
    "收到",
    "1",
    "你好",
    "你好啊",
    "您好",
    "hi",
    "hello",
    "早",
    "早上好",
}


def is_noise_event(event: LedgerEvent) -> bool:
    if event.ephemeral:
        return True
    if event.event_type in ["tool_call", "tool_result", "system", "subagent"]:
        return True
    clean_text = CODE_BLOCK_RE.sub(
        "", event.payload.get("text", "") or event.payload.get("content", "") or ""
    )
    normalized = re.sub(r"[^\w\u4e00-\u9fa5]", "", clean_text).lower()
    if normalized and normalized in TRIVIAL_REPLIES:
        return True

    return bool(event.payload.get("error"))
