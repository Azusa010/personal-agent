"""Coding Agent 端到端编程与自愈测试 (Phase 2 Task 2.4)

本测试套件验证：
1. 完整 Coding 自愈回路：
   - 步骤 1: 模型执行 file_write 写入代码，宿主即时探针返回语法/Linter 诊断 (diagnostics)
   - 步骤 2: 模型在下一轮审视 Observation 中的 diagnostics 告警，触发自愈反射回路发起 file_edit 局部修复
   - 步骤 3: 宿主返回修复成功且 diagnostics 为空（缺陷消除）
   - 步骤 4: 模型执行 terminal_execute 运行单测验证（TDD 闭环）并产出最终交付总结
2. 并发读探查 + 缺陷自愈综合场景：
   - 先并发执行 file_search 与 file_read 收集规范与已有代码
   - 写入代码产生告警后，精准执行 file_edit 修复
3. 诊断告警在上下文与历史对话中的完整保留与可追溯性
"""

from typing import Any

from personal_agent.context import ContextManager
from personal_agent.conversation.loop.concurrency import (
    register_capabilities,
)
from personal_agent.conversation.loop.react_loop import ReActLoop
from personal_agent.engine import Budget
from personal_agent.model_gateway import (
    BatchToolCallDecision,
    SummaryDecision,
    ToolCallDecision,
    ToolCallItem,
)
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolParams,
    HostExecuteToolResult,
)
from personal_agent.scripted_model import ScriptedModel

CODING_DESCRIPTORS = [
    CapabilityDescriptor(name="file_read", kind="READ", description="按行读取文件"),
    CapabilityDescriptor(name="file_search", kind="READ", description="检索文件或内容"),
    CapabilityDescriptor(name="file_write", kind="WRITE", description="写入新文件或覆盖"),
    CapabilityDescriptor(name="file_edit", kind="WRITE", description="精准唯一匹配局部编辑"),
    CapabilityDescriptor(name="terminal_execute", kind="WRITE", description="执行终端命令"),
]


class ScriptedCodingChannel:
    """模拟 Desktop 宿主返回结果通道（支持注入带有 diagnostics 的探针告警）。"""

    def __init__(self, step_results: list[dict[str, Any]]) -> None:
        self._results = list(step_results)
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        if not self._results:
            raise AssertionError(f"ScriptedCodingChannel 预设调用已耗尽: {params.capability}")
        data = self._results.pop(0)
        return HostExecuteToolResult.model_validate(data)


def test_e2e_coding_and_self_healing_cycle():
    """验证完整的「写盘 -> 捕获诊断 -> 精准自愈 -> 测试验收 -> 最终总结」自愈闭环。"""
    register_capabilities(CODING_DESCRIPTORS)

    # 1. 宿主预设返回值序列
    host_results = [
        # 第 1 步: file_write 落盘成功，但 Tier 0 即时语法探针检测出语法错误
        {
            "ok": True,
            "path": "src/math.ts",
            "bytesWritten": 45,
            "diagnostics": [
                "TypeScript Syntax Error (line 1, col 24): Expression expected."
            ],
        },
        # 第 2 步: 模型收到诊断后发起 file_edit 修复，探针重新检验返回空诊断（缺陷自愈）
        {
            "ok": True,
            "path": "src/math.ts",
            "replacements": 1,
            "diagnostics": [],
        },
        # 第 3 步: 模型执行 terminal_execute 跑测试，验证通过
        {
            "ok": True,
            "stdout": "PASS src/math.test.ts (1 test passed)\n",
            "stderr": "",
            "exitCode": 0,
        },
    ]

    # 2. 模型认知推理决策序列
    model_decisions = [
        # 轮次 1: 写入初始代码（存在缺陷）
        ToolCallDecision(
            kind="tool_call",
            callId="c_write_1",
            capability="file_write",
            arguments={"path": "src/math.ts", "content": "export const add = (a, b) => ;"},
            thinking="实现 add 函数并写入 src/math.ts",
        ),
        # 轮次 2: 审视上轮 Observation 发现 TypeScript 语法报错，决定发起局部修复
        ToolCallDecision(
            kind="tool_call",
            callId="c_edit_1",
            capability="file_edit",
            arguments={
                "path": "src/math.ts",
                "oldString": "export const add = (a, b) => ;",
                "newString": "export const add = (a: number, b: number): number => a + b;",
            },
            thinking="观测到 TypeScript Syntax Error 诊断告警，当前步骤优先通过 file_edit 自愈修复该语法缺陷",
        ),
        # 轮次 3: 语法修复通过后，主动运行测试验证 (TDD 完成态)
        ToolCallDecision(
            kind="tool_call",
            callId="c_test_1",
            capability="terminal_execute",
            arguments={"command": "npm test src/math.test.ts"},
            thinking="代码语法诊断已清除，运行单元测试进行 TDD 完成态验证",
        ),
        # 轮次 4: 测试全绿，输出最终交付总结
        SummaryDecision(
            kind="summary",
            reply="已成功编写 src/math.ts，自愈修复语法错误并通过单元测试验证。",
            facts=[{"text": "src/math.ts 编写并测试通过", "pageRefs": []}],
            thinking="所有检查均已通过，交付最终结果",
        ),
    ]

    channel = ScriptedCodingChannel(host_results)
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
        goal="编写 math.ts 并测试通过",
        visible_capabilities=[d.name for d in CODING_DESCRIPTORS],
    )

    # 断言 1: 任务最终成功完成
    assert outcome.kind == "completed"
    assert "自愈修复语法错误" in outcome.reply

    # 断言 2: 宿主工具调用次数与顺序符合预期
    assert len(channel.calls) == 3
    assert channel.calls[0].capability == "file_write"
    assert channel.calls[1].capability == "file_edit"
    assert channel.calls[2].capability == "terminal_execute"

    # 断言 3: ContextManager 的 observations 完整记录了每轮返回与 diagnostics 告警
    obs = context.observations
    assert len(obs) == 3

    # 第 1 步包含诊断警告
    assert obs[0].capability == "file_write"
    assert "diagnostics" in obs[0].payload
    assert len(obs[0].payload["diagnostics"]) == 1
    assert "Expression expected" in obs[0].payload["diagnostics"][0]

    # 第 2 步诊断警告已清除
    assert obs[1].capability == "file_edit"
    assert obs[1].payload.get("replacements") == 1
    assert obs[1].payload.get("diagnostics") == []

    # 第 3 步终端测试通过
    assert obs[2].capability == "terminal_execute"
    assert obs[2].payload.get("exitCode") == 0


def test_concurrent_read_then_self_healing_write():
    """验证并发多路探查 (Task 2.1) 与后置写盘自愈 (Task 2.3) 的流水线集成。"""
    register_capabilities(CODING_DESCRIPTORS)

    # 1. 宿主返回值（第 1 轮并发双读，第 2 轮单写带诊断，第 3 轮单改自愈）
    host_results = [
        # 并发读 1
        {"ok": True, "matches": [{"path": "specs/auth.spec.md", "line": 1}]},
        # 并发读 2
        {"ok": True, "path": "src/utils.ts", "content": "1: export const SECRET = 'xyz';"},
        # 写入代码（带 Linter 告警）
        {
            "ok": True,
            "path": "src/auth.ts",
            "bytesWritten": 60,
            "diagnostics": [
                "src/auth.ts:1:1: F401 `os` imported but unused",
            ],
        },
        # 自愈编辑
        {
            "ok": True,
            "path": "src/auth.ts",
            "replacements": 1,
            "diagnostics": [],
        },
    ]

    # 2. 模型决策序列
    model_decisions = [
        # 轮次 1: 并发下发两个 READ 请求
        BatchToolCallDecision(
            kind="batch_tool_call",
            calls=[
                ToolCallItem(
                    callId="c_search_1",
                    capability="file_search",
                    arguments={"pattern": "auth.spec", "mode": "filename"},
                ),
                ToolCallItem(
                    callId="c_read_1",
                    capability="file_read",
                    arguments={"path": "src/utils.ts"},
                ),
            ],
            thinking="并发探查规格说明与已有工具类",
        ),
        # 轮次 2: 根据探查结果写入实现
        ToolCallDecision(
            kind="tool_call",
            callId="c_write_2",
            capability="file_write",
            arguments={"path": "src/auth.ts", "content": "import os\nexport const login = () => true;"},
            thinking="写入认证实现",
        ),
        # 轮次 3: 响应 Linter 告警进行自愈
        ToolCallDecision(
            kind="tool_call",
            callId="c_edit_2",
            capability="file_edit",
            arguments={
                "path": "src/auth.ts",
                "oldString": "import os\n",
                "newString": "",
            },
            thinking="清除无用的 os 导入告警",
        ),
        # 轮次 4: 交付
        SummaryDecision(
            kind="summary",
            reply="已完成规范探查并生成通过静态分析的认证模块。",
            facts=[{"text": "认证模块已编写并通过 linter", "pageRefs": []}],
            thinking="完成交付",
        ),
    ]

    channel = ScriptedCodingChannel(host_results)
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
        goal="探查规范并编写认证模块",
        visible_capabilities=[d.name for d in CODING_DESCRIPTORS],
    )

    assert outcome.kind == "completed"
    assert len(channel.calls) == 4
    # 验证前两次是并发 READ，随后是两次串行 WRITE
    assert channel.calls[0].capability == "file_search"
    assert channel.calls[1].capability == "file_read"
    assert channel.calls[2].capability == "file_write"
    assert channel.calls[3].capability == "file_edit"

    # 验证上下文中的 observations 总数也是 4
    assert len(context.observations) == 4
    assert context.observations[2].payload["diagnostics"] == [
        "src/auth.ts:1:1: F401 `os` imported but unused"
    ]
    assert context.observations[3].payload["diagnostics"] == []
