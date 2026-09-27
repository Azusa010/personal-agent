"""
tool_schema_generator.py
根据 Pydantic 模型动态推导符合 OpenAI Function Calling 标准的 Tool Schema。
消除手工维护 300 行 JSON Schema 字典，保证与协议契约严格一致（单一事实来源）。
"""

from typing import Any, get_args

from pydantic import BaseModel

from personal_agent.protocol.models import (
    CapabilityId,
    CodeInterpreterParams,
    DocumentExtractPdfParams,
    FileSearchParams,
    FilesystemCreateDirParams,
    FilesystemListParams,
    FilesystemMoveParams,
    KnowledgeSearchParams,
    NotificationSendParams,
    ReadDocumentParams,
    SchedulerCreateParams,
    SkillReadParams,
    SkillSearchParams,
    TerminalExecuteParams,
    UserMemorySearchParams,
    VikingReadL0Params,
    VikingReadL1Params,
    VikingReadL2Params,
    VikingWriteL2Params,
    WebSearchParams,
)

# 能力与入参 Pydantic 模型映射
TOOL_PARAM_MODELS: dict[str, type[BaseModel]] = {
    "filesystem_list": FilesystemListParams,
    "document_extract_pdf": DocumentExtractPdfParams,
    "read_document": ReadDocumentParams,
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
    "code_interpreter": CodeInterpreterParams,
    "file_search": FileSearchParams,
    "skill_search": SkillSearchParams,
    "skill_read": SkillReadParams,
    "web_search": WebSearchParams,
}

# 工具层级高阶描述说明（对齐 ACI 目标导向）
TOOL_DESCRIPTIONS: dict[str, str] = {
    "web_search": "使用 Tavily 搜索引擎在互联网上实时检索最新网页资讯与事实答案",
    "filesystem_list": "列出指定授权根目录下的文件与子目录条目",
    "document_extract_pdf": "解析并提取 PDF 文件的逐页文本与页码",
    "read_document": "多格式统一文档读取器，支持分页、文本截断控制与结构化提取 (PDF/Word/Markdown/Text)",
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
    "code_interpreter": "在隔离沙盒内运行 Python 代码，用于复杂数据计算与批量文件处理",
    "file_search": "跨平台文件搜索，支持按文件名通配符或文本内容进行检索",
    "skill_search": "按关键词或标签检索 Agent Skills 目录，仅返回轻量元数据以保护上下文",
    "skill_read": "按需加载指定 Skill 的完整指令正文 (SKILL.md)，实现渐进式披露",
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
    "code_interpreter": {
        "code": "要执行的 Python 代码段",
        "timeoutMs": "超时时间（毫秒，默认 30000）",
        "saveArtifacts": "是否持久化产生的输出文件",
    },
    "file_search": {
        "pattern": "文件名通配符或搜索关键词",
        "searchMode": "搜索模式：filename (文件名), content_plain (纯文本内容), content_regex (正则内容)",
        "relativeRoot": "可选的子目录相对路径",
        "maxMatches": "最大匹配条数（默认 50）",
    },
    "web_search": {
        "query": "搜索关键词或自然语言问题",
        "maxResults": "可选返回网页条数，默认5，最大20",
        "searchDepth": "可选检索深度：'basic' (快速) 或 'advanced' (高精度深入)",
        "includeAnswer": "可选是否包含 Tavily AI 提取的直接答案",
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
