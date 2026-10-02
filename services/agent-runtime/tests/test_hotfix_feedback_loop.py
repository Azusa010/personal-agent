"""
test_hotfix_feedback_loop.py
自适应热修反馈环与能力固化 E2E 测试 (TASK-E2 - Python 运行时侧)。

验证：
1. 完整热修反馈环：
   - 遭遇非标数据/异常 -> 模型通过 code_interpreter 编写即兴适配脚本
   - 宿主在沙箱中运行并返回结构化输出
   - 模型审视 Observation 确认输出正确后，依次调用 file_write 固化工具与技能卡
   - 模型输出最终交付总结完成闭环
2. 适配代码容错自愈：
   - 首轮即兴脚本语法/运行出错时，错误回灌至上下文
   - 模型自愈修复脚本再次验证，成功后方才固化
3. 技能沉淀后免疫复用：
   - 后续相似任务通过 skill_search / skill_read 发现已有适配器，无需重新推理编写
"""

from typing import Any

from personal_agent.context import ContextManager
from personal_agent.conversation.loop.concurrency import register_capabilities
from personal_agent.engine import Budget
from personal_agent.model_gateway import SummaryDecision, ToolCallDecision
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolParams,
    HostExecuteToolResult,
)
from personal_agent.react_loop import ReActLoop
from personal_agent.scripted_model import ScriptedModel

HOTFIX_CAPABILITIES = [
    CapabilityDescriptor(name="code_interpreter", kind="WRITE", description="沙盒运行 Python 代码"),
    CapabilityDescriptor(name="file_write", kind="WRITE", description="写入工作区文件"),
    CapabilityDescriptor(name="skill_search", kind="READ", description="按关键词或标签检索技能"),
    CapabilityDescriptor(name="skill_read", kind="READ", description="按需加载指定技能完整说明"),
    CapabilityDescriptor(name="terminal_execute", kind="WRITE", description="执行终端命令"),
]


class ScriptedHotfixChannel:
    """受控的宿主通道，记录工具调用并按序返回预设结果。"""

    def __init__(self, step_results: list[dict[str, Any]]) -> None:
        self._results = list(step_results)
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        if not self._results:
            raise AssertionError(f"ScriptedHotfixChannel 预设调用已耗尽: {params.capability}")
        data = self._results.pop(0)
        return HostExecuteToolResult.model_validate(data)


def test_hotfix_feedback_loop_react_e2e():
    """验证 ReAct 循环中「遇错 -> 沙箱即兴适配 -> 固化工具脚本与技能卡 -> 总结交付」闭环。"""
    register_capabilities(HOTFIX_CAPABILITIES)

    host_results = [
        # 1. code_interpreter 沙箱运行即兴适配脚本，返回结构化 JSON 输出
        {
            "ok": True,
            "stdout": '[{"timestamp": "2026-10-02 12:00:01", "ip": "192.168.1.1", "status": 200}]',
            "stderr": "",
            "exitCode": 0,
        },
        # 2. file_write 固化工具可执行脚本到 .agent/tools/
        {
            "ok": True,
            "path": ".agent/tools/access_parser.py",
            "bytesWritten": 650,
        },
        # 3. file_write 固化指导说明到 .agent/skills/
        {
            "ok": True,
            "path": ".agent/skills/access-parser/SKILL.md",
            "bytesWritten": 420,
        },
    ]

    model_decisions = [
        # 轮次 1: 发现非标格式，调用 code_interpreter 在沙盒中即兴编写适配脚本
        ToolCallDecision(
            kind="tool_call",
            callId="c_adhoc_1",
            capability="code_interpreter",
            arguments={
                "code": "import re, json\n# 解析非标日志样本并转换为标准结构化记录\nrecords = [{'timestamp': '2026-10-02 12:00:01', 'ip': '192.168.1.1', 'status': 200}]\nprint(json.dumps(records))",
            },
            thinking="目标数据为非标格式，无现成 SDK，优先调用 code_interpreter 编写即兴适配器并在沙盒中验证",
        ),
        # 轮次 2: 审视沙盒输出确认正确，将工具脚本固化沉淀到工作区
        ToolCallDecision(
            kind="tool_call",
            callId="c_solidify_tool",
            capability="file_write",
            arguments={
                "path": ".agent/tools/access_parser.py",
                "content": "#!/usr/bin/env python3\n# Tool: access_parser\n# ... 经过沙箱验证的正式解析器实现 ...\n",
            },
            thinking="适配逻辑已在沙箱中验证通过，将其沉淀固化到 .agent/tools/ 供后续任务复用",
        ),
        # 轮次 3: 固化技能卡 SKILL.md
        ToolCallDecision(
            kind="tool_call",
            callId="c_solidify_skill",
            capability="file_write",
            arguments={
                "path": ".agent/skills/access-parser/SKILL.md",
                "content": "---\nname: access-parser\ndescription: 解析非标访问日志\ntags: [log, parser, adapter]\n---\n# Access Parser\n使用方法：python .agent/tools/access_parser.py <file>\n",
            },
            thinking="为固化工具配套生成 Agent Skills Specification 规范的技能指导书",
        ),
        # 轮次 4: 交付任务
        SummaryDecision(
            kind="summary",
            reply="已通过 code_interpreter 即兴编写并验证日志适配器，并成功将其固化为 .agent/tools/access_parser.py 与 .agent/skills/access-parser/SKILL.md 技能卡，后续同类任务可直接免疫复用。",
            facts=[{"text": "非标日志适配器已编写验证并固化为工作区技能", "pageRefs": []}],
            thinking="热修反馈环全链路完成，交付总结",
        ),
    ]

    channel = ScriptedHotfixChannel(host_results)
    model = ScriptedModel(model_decisions)
    context = ContextManager(plan=())
    budget = Budget(maxSteps=10, maxToolCalls=10)

    loop = ReActLoop(
        channel=channel,
        model=model,
        context=context,
        budget=budget,
    )

    outcome = loop.run(
        goal="适配非标访问日志并固化为项目可用技能",
        visible_capabilities=[d.name for d in HOTFIX_CAPABILITIES],
    )

    assert outcome.kind == "completed"
    assert "固化为 .agent/tools/access_parser.py" in outcome.reply
    assert len(channel.calls) == 3
    assert channel.calls[0].capability == "code_interpreter"
    assert channel.calls[1].capability == "file_write"
    assert channel.calls[2].capability == "file_write"

    # 上下文观测完整记录了沙箱执行结果与文件写入
    assert len(context.observations) == 3
    assert "192.168.1.1" in context.observations[0].payload.get("stdout", "")
    assert context.observations[1].payload.get("path") == ".agent/tools/access_parser.py"
    assert context.observations[2].payload.get("path") == ".agent/skills/access-parser/SKILL.md"


def test_hotfix_feedback_loop_with_error_and_retry():
    """验证即兴编写适配脚本发生错误时，模型接收错误反馈并自愈修复后方才固化。"""
    register_capabilities(HOTFIX_CAPABILITIES)

    host_results = [
        # 1. 首次运行语法报错
        {
            "ok": True,
            "stdout": "",
            "stderr": "SyntaxError: unterminated string literal",
            "exitCode": 1,
        },
        # 2. 修复后重新运行成功
        {
            "ok": True,
            "stdout": '[{"status": "recovered"}]',
            "stderr": "",
            "exitCode": 0,
        },
        # 3. 固化工具脚本
        {
            "ok": True,
            "path": ".agent/tools/repaired_parser.py",
            "bytesWritten": 400,
        },
    ]

    model_decisions = [
        # 轮次 1: 发起初版适配脚本调用
        ToolCallDecision(
            kind="tool_call",
            callId="c_buggy_code",
            capability="code_interpreter",
            arguments={"code": 'print("unterminated)'},
            thinking="尝试编写适配脚本",
        ),
        # 轮次 2: 观测到 SyntaxError，分析错误并修复代码重试
        ToolCallDecision(
            kind="tool_call",
            callId="c_fixed_code",
            capability="code_interpreter",
            arguments={"code": 'import json; print(json.dumps([{"status": "recovered"}]))'},
            thinking="沙盒执行返回 SyntaxError，纠正字符串闭合语法后重新验证",
        ),
        # 轮次 3: 验证通过，发起固化
        ToolCallDecision(
            kind="tool_call",
            callId="c_write_repaired",
            capability="file_write",
            arguments={
                "path": ".agent/tools/repaired_parser.py",
                "content": "#!/usr/bin/env python3\n# Repaired Tool\n",
            },
            thinking="沙盒验证通过，执行工具固化",
        ),
        # 轮次 4: 交付
        SummaryDecision(
            kind="summary",
            reply="自适应修复了适配脚本中的语法错误，验证成功并沉淀为可用工具。",
            facts=[],
            thinking="完成交付",
        ),
    ]

    channel = ScriptedHotfixChannel(host_results)
    model = ScriptedModel(model_decisions)
    context = ContextManager(plan=())
    budget = Budget(maxSteps=10, maxToolCalls=10)

    loop = ReActLoop(
        channel=channel,
        model=model,
        context=context,
        budget=budget,
    )

    outcome = loop.run(
        goal="热修语法错误并固化工具",
        visible_capabilities=[d.name for d in HOTFIX_CAPABILITIES],
    )

    assert outcome.kind == "completed"
    assert "自适应修复了适配脚本中的语法错误" in outcome.reply
    assert len(channel.calls) == 3
    assert channel.calls[0].capability == "code_interpreter"
    assert channel.calls[1].capability == "code_interpreter"
    assert channel.calls[2].capability == "file_write"


def test_subsequent_task_reuses_solidified_skill_without_adhoc_interpreter():
    """验证固化后技能能够通过 skill_search / skill_read 被直接发现并指导复用。"""
    register_capabilities(HOTFIX_CAPABILITIES)

    host_results = [
        # 1. 技能检索返回轻量元数据
        {
            "ok": True,
            "total": 1,
            "skills": [
                {
                    "name": "access-parser",
                    "description": "解析非标访问日志",
                    "tags": ["log", "parser", "adapter"],
                    "path": ".agent/skills/access-parser/SKILL.md",
                }
            ],
        },
        # 2. 技能详情读取
        {
            "ok": True,
            "name": "access-parser",
            "description": "解析非标访问日志",
            "tags": ["log", "parser", "adapter"],
            "content": "# Access Parser\n使用方法：python .agent/tools/access_parser.py <file>\n",
            "path": ".agent/skills/access-parser/SKILL.md",
        },
    ]

    model_decisions = [
        # 轮次 1: 用户要求处理新日志，模型首先检索技能库
        ToolCallDecision(
            kind="tool_call",
            callId="c_search_skill",
            capability="skill_search",
            arguments={"query": "access-parser"},
            thinking="面对日志解析诉求，首先通过 skill_search 检索已有技能",
        ),
        # 轮次 2: 发现已有技能，按需加载使用指南
        ToolCallDecision(
            kind="tool_call",
            callId="c_read_skill",
            capability="skill_read",
            arguments={"name": "access-parser"},
            thinking="发现已沉淀的 access-parser 技能，通过 skill_read 加载具体用法",
        ),
        # 轮次 3: 根据技能文档直接完成指导
        SummaryDecision(
            kind="summary",
            reply="已通过 skill_search 与 skill_read 命中固化的 access-parser 技能，可直接运行 python .agent/tools/access_parser.py 处理新日志。",
            facts=[{"text": "成功复用已沉淀的技能指导书", "pageRefs": []}],
            thinking="复用已有技能完成任务",
        ),
    ]

    channel = ScriptedHotfixChannel(host_results)
    model = ScriptedModel(model_decisions)
    context = ContextManager(plan=())
    budget = Budget(maxSteps=10, maxToolCalls=10)

    loop = ReActLoop(
        channel=channel,
        model=model,
        context=context,
        budget=budget,
    )

    outcome = loop.run(
        goal="使用已有技能处理新日志",
        visible_capabilities=[d.name for d in HOTFIX_CAPABILITIES],
    )

    assert outcome.kind == "completed"
    assert "命中固化的 access-parser 技能" in outcome.reply
    assert len(channel.calls) == 2
    assert channel.calls[0].capability == "skill_search"
    assert channel.calls[1].capability == "skill_read"
