"""tests/test_decision_normalizer.py —— 模型决策容错归一化器的单元测试。

验证当 LLM 输出不带 'kind' 顶层判别字段（或输出裸参数字典、Function Calling 格式、
单键包裹格式）时，能够自动识别并安全归一化为符合 ModelDecision 契约的合法字典。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from personal_agent.conversation.model.decision_normalizer import (
    extract_python_code,
    normalize_raw_decision,
    should_heal_to_code_interpreter,
)
from personal_agent.conversation.model.gateway import (
    BatchToolCallDecision,
    ModelContext,
    ReplanDecision,
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.model.live_model import DECISION_ADAPTER
from personal_agent.protocol.models import PlanStepDto


def test_normalize_preserves_valid_tagged_decisions():
    """已有合法 kind 判别符的决策应原样保留，通过 Pydantic 校验。"""
    raw_tool = {
        "kind": "tool_call",
        "callId": "call-1",
        "capability": "terminal_execute",
        "arguments": {"command": "dir"},
    }
    decision = DECISION_ADAPTER.validate_python(normalize_raw_decision(raw_tool))
    assert isinstance(decision, ToolCallDecision)
    assert decision.capability == "terminal_execute"

    raw_summary = {"kind": "summary", "reply": "任务完成", "facts": []}
    decision_summary = DECISION_ADAPTER.validate_python(
        normalize_raw_decision(raw_summary)
    )
    assert isinstance(decision_summary, SummaryDecision)
    assert decision_summary.reply == "任务完成"


def test_normalize_raw_tool_arguments_without_kind_reproduces_user_bug():
    """复现并修复用户实际 BUG：模型直接输出了 terminal_execute 的裸入参字典。"""
    raw = {"command": 'powershell -NoProfile -Command "Get-Process"', "timeoutMs": 15000}
    normalized = normalize_raw_decision(raw)

    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "terminal_execute"
    assert normalized["arguments"]["command"] == (
        'powershell -NoProfile -Command "Get-Process"'
    )
    assert normalized["arguments"]["timeoutMs"] == 15000
    assert normalized["callId"] == "call-1"

    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, ToolCallDecision)
    assert decision.capability == "terminal_execute"
    assert decision.arguments["timeoutMs"] == 15000


def test_normalize_tool_arguments_with_thinking():
    """模型输出裸参数字典同时附带 thinking 思考摘要。"""
    raw = {
        "thinking": "当前需要执行命令检查系统进程状态",
        "command": "Get-Service",
        "timeoutMs": 8000,
    }
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "terminal_execute"
    assert normalized["thinking"] == "当前需要执行命令检查系统进程状态"
    assert "thinking" not in normalized["arguments"]
    assert normalized["arguments"]["command"] == "Get-Service"


def test_normalize_other_distinct_tool_signatures():
    """特征参数字典能自动准确反查出对应的 capability。"""
    # code_interpreter: 特征参数 code
    raw_code = {"code": "print(1 + 1)", "timeoutMs": 5000}
    norm_code = normalize_raw_decision(raw_code)
    assert norm_code["kind"] == "tool_call"
    assert norm_code["capability"] == "code_interpreter"
    assert norm_code["arguments"]["code"] == "print(1 + 1)"

    # scheduler_create: 特征参数 remindAt, message
    raw_sched = {"remindAt": "2026-10-01T00:00:00Z", "message": "国庆提醒"}
    norm_sched = normalize_raw_decision(raw_sched)
    assert norm_sched["kind"] == "tool_call"
    assert norm_sched["capability"] == "scheduler_create"

    # notification_send: 特征参数 reminderId
    raw_notif = {"reminderId": "rem-123"}
    norm_notif = normalize_raw_decision(raw_notif)
    assert norm_notif["kind"] == "tool_call"
    assert norm_notif["capability"] == "notification_send"

    # filesystem_move: 特征参数 source, target
    raw_move = {"source": "/path/a", "target": "/path/b"}
    norm_move = normalize_raw_decision(raw_move)
    assert norm_move["kind"] == "tool_call"
    assert norm_move["capability"] == "filesystem_move"

    # filesystem_list: 特征参数 rootId
    raw_list = {"rootId": "downloads"}
    norm_list = normalize_raw_decision(raw_list)
    assert norm_list["kind"] == "tool_call"
    assert norm_list["capability"] == "filesystem_list"


def test_normalize_path_based_capabilities_disambiguated_by_context():
    """包含 path 的裸参数，根据 context.plan 当前活跃步骤消歧。"""
    ctx = ModelContext(
        taskGoal="提取 PDF 报告",
        plan=[
            PlanStepDto(description="提取销售数据", capability="document_extract_pdf"),
            PlanStepDto(description="创建归档目录", capability="filesystem_create_dir"),
        ],
        visibleCapabilities=["document_extract_pdf", "filesystem_create_dir"],
    )
    raw = {"path": "C:/docs/report.pdf"}
    normalized = normalize_raw_decision(raw, context=ctx)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "document_extract_pdf"


def test_normalize_tool_call_missing_kind_only():
    """已有 capability 和 arguments 但缺少 kind。"""
    raw = {
        "capability": "terminal_execute",
        "arguments": {"command": "whoami"},
        "callId": "my-call-99",
    }
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "tool_call"
    assert normalized["callId"] == "my-call-99"
    assert normalized["capability"] == "terminal_execute"


def test_normalize_flattened_tool_call_missing_kind():
    """顶层带 capability，但参数与 capability 平级展平在顶层。"""
    raw = {
        "capability": "terminal_execute",
        "command": "dir",
        "timeoutMs": 3000,
    }
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "terminal_execute"
    assert normalized["arguments"] == {"command": "dir", "timeoutMs": 3000}


def test_normalize_standard_function_calling_and_react_formats():
    """兼容 OpenAI 原生 name/arguments、tool/parameters 以及 ReAct action 格式。"""
    # OpenAI function style
    raw_fn = {"name": "terminal_execute", "arguments": {"command": "pwd"}}
    norm_fn = normalize_raw_decision(raw_fn)
    assert norm_fn["kind"] == "tool_call"
    assert norm_fn["capability"] == "terminal_execute"

    # tool/parameters style
    raw_tool = {"tool": "terminal_execute", "parameters": {"command": "pwd"}}
    norm_tool = normalize_raw_decision(raw_tool)
    assert norm_tool["kind"] == "tool_call"
    assert norm_tool["capability"] == "terminal_execute"

    # nested function object style
    raw_nested = {
        "function": {"name": "terminal_execute", "arguments": {"command": "pwd"}}
    }
    norm_nested = normalize_raw_decision(raw_nested)
    assert norm_nested["kind"] == "tool_call"
    assert norm_nested["capability"] == "terminal_execute"

    # ReAct style
    raw_react = {"action": "terminal_execute", "action_input": {"command": "pwd"}}
    norm_react = normalize_raw_decision(raw_react)
    assert norm_react["kind"] == "tool_call"
    assert norm_react["capability"] == "terminal_execute"


def test_normalize_single_key_wrapped_tool():
    """模型输出形如 {"terminal_execute": {"command": "dir"}}。"""
    raw = {"terminal_execute": {"command": "dir", "timeoutMs": 5000}}
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "terminal_execute"
    assert normalized["arguments"] == {"command": "dir", "timeoutMs": 5000}


def test_normalize_finish_task_to_summary():
    """模型通过工具调用形式调用 finish_task 收尾。"""
    raw = {
        "name": "finish_task",
        "arguments": {
            "reply": "所有任务处理完成",
            "facts": [{"text": "文件大小为 10KB", "pageRefs": [1]}],
        },
    }
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "summary"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, SummaryDecision)
    assert decision.reply == "所有任务处理完成"
    assert len(decision.facts) == 1


def test_normalize_summary_without_kind():
    """模型输出了 reply 总结文本但缺少 kind='summary'。"""
    raw = {"reply": "你好！我已经整理好了所有文件。"}
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "summary"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, SummaryDecision)
    assert decision.reply == "你好！我已经整理好了所有文件。"


def test_normalize_step_complete_without_kind():
    """模型输出了 result 但缺少 kind='step_complete'。"""
    raw = {"result": "成功解压了压缩包"}
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "step_complete"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, StepCompleteDecision)
    assert decision.result == "成功解压了压缩包"


def test_normalize_replan_without_kind():
    """模型输出了 reason 但缺少 kind='replan'。"""
    raw = {"reason": "原文件格式损坏无法读取"}
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "replan"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, ReplanDecision)
    assert decision.reason == "原文件格式损坏无法读取"


def test_normalize_batch_tool_call_without_kind():
    """模型输出了 calls 数组但缺少 kind='batch_tool_call'。"""
    raw = {
        "calls": [
            {
                "callId": "c1",
                "capability": "terminal_execute",
                "arguments": {"command": "echo 1"},
            }
        ]
    }
    normalized = normalize_raw_decision(raw)
    assert normalized["kind"] == "batch_tool_call"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, BatchToolCallDecision)
    assert len(decision.calls) == 1


def test_normalize_empty_or_unrecognized_dict_raises_validation_error():
    """无法归一化的空字典或完全无关对象，依然保留给 Pydantic 抛出契约错误。"""
    raw = {"unrelated_field": 12345}
    normalized = normalize_raw_decision(raw)
    # 不应该凭空捏造 kind，让 Pydantic 报告契约不符
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python(normalized)


def test_extract_python_code_various_formats():
    """测试 extract_python_code 对不同代码表现形式的提取与非代码识别。"""
    # 裸脚本
    raw_script = "cities = ['北京', '上海', '广州', '深圳']\nprint('---')"
    assert extract_python_code(raw_script) == raw_script

    # Markdown 代码块
    md_block = "```python\nimport itertools\nprint(123)\n```"
    assert extract_python_code(md_block) == "import itertools\nprint(123)"

    # 前缀解释性文字 + 代码
    prefixed = "我来用代码算一下：\nimport math\nprint(math.sqrt(16))"
    assert extract_python_code(prefixed) == "import math\nprint(math.sqrt(16))"

    # 非代码普通对话与 JSON 应返回 None
    assert extract_python_code("我觉得这个任务应该这样完成。") is None
    assert extract_python_code('{"kind": "summary", "reply": "ok"}') is None
    assert extract_python_code("Hello! How can I help you today?") is None


def test_normalize_mangled_json_repair_list_recovers_to_code_interpreter():
    """复现实际现场 BUG：模型输出裸 Python 代码，经 json_repair 误修成 list，成功挽救为 code_interpreter 调用。"""
    raw_text = "cities = ['北京', '上海', '广州', '深圳']\nprint('---')"
    # json_repair 修复代码片段产生的残损 list 结构
    mangled_list = [["北京", "上海", "广州", "深圳"], {'print("---': ""}]

    ctx = ModelContext(
        taskGoal="求解旅行商问题",
        plan=[
            PlanStepDto(description="编写代码求解最短路径", capability="code_interpreter"),
            PlanStepDto(description="直接回答用户", capability=None),
        ],
        visibleCapabilities=["code_interpreter"],
    )

    normalized = normalize_raw_decision(mangled_list, context=ctx, raw_text=raw_text)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "code_interpreter"
    assert normalized["arguments"]["code"] == raw_text

    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, ToolCallDecision)
    assert decision.capability == "code_interpreter"
    assert decision.arguments["code"] == raw_text


def test_normalize_list_of_tool_calls_normalized_to_batch_tool_call():
    """模型直接输出了 tool_call 字典数组，自动归一化为 batch_tool_call。"""
    raw_list = [
        {"capability": "code_interpreter", "arguments": {"code": "print(1)"}},
        {"capability": "code_interpreter", "arguments": {"code": "print(2)"}},
    ]
    normalized = normalize_raw_decision(raw_list)
    assert normalized["kind"] == "batch_tool_call"
    assert len(normalized["calls"]) == 2
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, BatchToolCallDecision)
    assert len(decision.calls) == 2


def test_normalize_single_item_tool_call_list_normalized_to_single_tool_call():
    """模型输出了仅含单个 tool_call 的数组，平展为单一 tool_call。"""
    raw_list = [{"capability": "code_interpreter", "arguments": {"code": "print(1)"}}]
    normalized = normalize_raw_decision(raw_list)
    assert normalized["kind"] == "tool_call"
    assert normalized["capability"] == "code_interpreter"
    decision = DECISION_ADAPTER.validate_python(normalized)
    assert isinstance(decision, ToolCallDecision)


def test_do_not_heal_python_code_when_active_step_is_direct_reply():
    """当当前计划步骤是直接回答用户时，严禁将文本中的代码片段自愈为 code_interpreter 调用。"""
    ctx = ModelContext(
        taskGoal="解答 Python 语法疑问",
        plan=[
            PlanStepDto(description="直接回答用户", capability=None),
        ],
        visibleCapabilities=["code_interpreter"],
    )
    assert should_heal_to_code_interpreter(ctx) is False

    # 当已有一步完成进入直接回答步骤时：
    ctx2 = ModelContext(
        taskGoal="求解旅行商问题",
        plan=[
            PlanStepDto(description="编写代码求解最短路径", capability="code_interpreter"),
            PlanStepDto(description="直接回答用户", capability=None),
        ],
        observations=[{"callId": "c1", "capability": "code_interpreter", "ok": True}],
        visibleCapabilities=["code_interpreter"],
    )
    assert should_heal_to_code_interpreter(ctx2) is False
