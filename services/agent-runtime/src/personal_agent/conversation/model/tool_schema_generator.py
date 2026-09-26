"""
tool_schema_generator.py
根据 Pydantic 模型动态推导符合 OpenAI Function Calling 标准的 Tool Schema。
消除手工维护 300 行 JSON Schema 字典，保证与协议契约严格一致（单一事实来源）。
"""

from typing import Any, get_args

from pydantic import BaseModel

from personal_agent.protocol.models import (
    CapabilityId,
    DocumentExtractPdfParams,
    FilesystemCreateDirParams,
    FilesystemListParams,
    FilesystemMoveParams,
    KnowledgeSearchParams,
    NotificationSendParams,
    SchedulerCreateParams,
    TerminalExecuteParams,
    UserMemorySearchParams,
    VikingReadL0Params,
    VikingReadL1Params,
    VikingReadL2Params,
    VikingWriteL2Params,
)

# 能力与入参 Pydantic 模型映射
TOOL_PARAM_MODELS: dict[str, type[BaseModel]] = {
    "filesystem_list": FilesystemListParams,
    "document_extract_pdf": DocumentExtractPdfParams,
    "filesystem_create_dir": FilesystemCreateDirParams,
    "filesystem_move": FilesystemMoveParams,
    "scheduler_create": SchedulerCreateParams,
    "notification_send": NotificationSendParams,
    "terminal_execute": TerminalExecuteParams,
    "knowledge_search": KnowledgeSearchParams,
    "user_memory_search": UserMemorySearchParams,
    "viking_read_l0": VikingReadL0Params,
    "viking_read_l1": VikingReadL1Params,
    "viking_read_l2": VikingReadL2Params,
    "viking_write_l2": VikingWriteL2Params,
}

# 工具层级高阶描述说明（对齐 ACI 目标导向）
TOOL_DESCRIPTIONS: dict[str, str] = {
    "filesystem_list": "列出指定授权根目录下的文件与子目录条目",
    "document_extract_pdf": "解析并提取 PDF 文件的逐页文本与页码",
    "filesystem_create_dir": "在授权根目录下创建新目录",
    "filesystem_move": "在授权根内移动或重命名文件/目录",
    "scheduler_create": "创建定时提醒任务",
    "notification_send": "向宿主桌面发送即时通知",
    "terminal_execute": "在安全受限环境下执行终端命令行",
    "knowledge_search": "在本地知识库中进行混合语义检索与关键词检索",
    "user_memory_search": "在长期用户记忆中检索相关事实、偏好、习惯与历史经历",
    "viking_read_l0": "读取 Viking 维基条目的 L0 摘要 (.abstract)",
    "viking_read_l1": "读取 Viking 维基目录的 L1 概览 (.overview)",
    "viking_read_l2": "读取 Viking 维基条目的 L2 全文 (*.md)",
    "viking_write_l2": "写入或更新 Viking 维基条目的 L2 全文 (*.md)",
}

# 字段级语义描述增强（提供具象样例与约束）
PROPERTY_DESCRIPTIONS: dict[str, dict[str, str]] = {
    "filesystem_list": {
        "rootId": "授权根标识，如 downloads",
    },
    "document_extract_pdf": {
        "path": "目标 PDF 文件的绝对路径",
    },
    "filesystem_create_dir": {
        "path": "目标目录绝对路径",
    },
    "filesystem_move": {
        "source": "源绝对路径",
        "target": "目标绝对路径",
    },
    "scheduler_create": {
        "remindAt": "ISO-8601 UTC 时间，例如 2026-09-26T20:00:00Z",
        "message": "提醒内容",
    },
    "notification_send": {
        "reminderId": "提醒记录ID",
    },
    "terminal_execute": {
        "command": "要执行的命令行指令",
        "cwd": "可选的工作目录绝对路径",
        "timeoutMs": "可选的超时时间（毫秒）",
    },
    "knowledge_search": {
        "query": "要检索的问题或关键词",
        "topK": "可选返回的最优候选条数（默认 5）",
    },
    "user_memory_search": {
        "query": "要检索的问题、偏好或事实关键词",
        "topK": "可选返回的最优候选条数（默认 5）",
        "category": "可选的记忆分类：identity, preference, event, skill, routine",
        "person": "可选的人物实体，如 本人",
        "relationship": "可选的关系，如 本人、配偶、主管",
    },
    "viking_read_l0": {
        "uri": "Viking 虚拟 URI，以 viking:// 开头",
    },
    "viking_read_l1": {
        "uri": "Viking 虚拟 URI，以 viking:// 开头",
    },
    "viking_read_l2": {
        "uri": "Viking 虚拟 URI，以 viking:// 开头",
    },
    "viking_write_l2": {
        "uri": "Viking 虚拟 URI，以 viking:// 开头",
        "content": "待写入的 Markdown 正文",
    },
}


def generate_tool_schema(capability: str, description: str | None = None) -> dict[str, Any]:
    """根据能力名称及其对应的 Pydantic 模型生成 OpenAI Function Calling 规范。"""
    model_cls = TOOL_PARAM_MODELS.get(capability)
    desc = description or TOOL_DESCRIPTIONS.get(capability, "")
    if model_cls is None:
        return {
            "type": "function",
            "function": {
                "name": capability,
                "description": desc,
                "parameters": {"type": "object", "properties": {}},
            },
        }

    schema = model_cls.model_json_schema()
    schema.pop("title", None)
    schema.pop("description", None)
    schema.pop("additionalProperties", None)

    prop_descs = PROPERTY_DESCRIPTIONS.get(capability, {})
    properties = schema.get("properties", {})
    for prop_name, prop_val in properties.items():
        if isinstance(prop_val, dict):
            prop_val.pop("title", None)
            if "description" not in prop_val and prop_name in prop_descs:
                prop_val["description"] = prop_descs[prop_name]

    return {
        "type": "function",
        "function": {
            "name": capability,
            "description": desc,
            "parameters": schema,
        },
    }


def generate_all_tool_schemas() -> dict[str, dict[str, Any]]:
    """生成协议中所有已注册能力的 OpenAI Tool Schema 字典。"""
    all_caps = get_args(CapabilityId)
    return {cap: generate_tool_schema(cap) for cap in all_caps}
