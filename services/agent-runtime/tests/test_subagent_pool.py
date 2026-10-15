"""services/agent-runtime/tests/test_subagent_pool.py

测试网：主从日志隔离的可克隆子 Agent 池（Forkable Subagent Pool & Trace Isolation）。
验证：
1. 常驻母体预热 (SubagentPrototype) 保持静态 Prompt 前缀与工具定义，吃满 API Prefix Cache。
2. 工具白名单筛选 (Tool Whitelist Filtering) 保证子 Agent 最小权限隔离。
3. 子 Agent 生命周期状态机 (SubagentInstance) 严格约束合法状态转换。
4. 轨迹物理隔离器 (TraceIsolator) 顺序记录思考链、工具调用与结果，支持按事件过滤。
5. 零泄漏铁律 (Zero Noise Leakage)：子 Agent 密集的探索与报错绝不污染主事件日志。
6. 浓缩结论回灌 (Distilled Result Backfeed)：子 Agent 完成后向主日志写入且仅写入 1 条事实指针。
7. 子 Agent 池 (SubagentPool) 统一管理生命周期与回灌接线。
8. 高并发执行隔离 (Concurrent Execution Isolation)：多线程并发派生与独立落盘无锁争用无串号。
9. 失败与异常熔断处理 (Failure & Cancellation Handling)。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pytest

from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.subagent import (
    SubagentConfig,
    SubagentInstance,
    SubagentPool,
    SubagentPrototype,
    SubagentResult,
    SubagentTraceEvent,
    TraceIsolator,
    backfeed_to_main_ledger,
)


def _sample_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "read_file",
            "description": "Read file contents",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
        {
            "name": "grep_search",
            "description": "Search regex pattern across workspace",
            "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}},
        },
        {
            "name": "list_directory",
            "description": "List files in a directory",
            "parameters": {"type": "object", "properties": {"dir": {"type": "string"}}},
        },
        {
            "name": "execute_command",
            "description": "Execute shell command",
            "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
        },
    ]


def test_prototype_prefix_caching_and_instruction_order(tmp_path: Path):
    """验证母体原型保持固定 System Prompt 前缀，fork 派生时静态前缀保持不变以吃满 API Prefix Cache。"""
    base_prefix = "You are PersonalAgent Base Intelligence. Follow safety boundaries and core conventions."
    tools = _sample_tools()
    prototype = SubagentPrototype(
        system_prompt=base_prefix,
        base_tools=tools,
        model="claude-3-5-sonnet-20241022",
        default_traces_dir=tmp_path / "logs" / "subagent_traces",
    )

    # 派生子 Agent A
    agent_a = prototype.fork(
        role="Explorer",
        goal="Explore project structure and find ledger files",
        specific_instructions="Focus on services/ directory only.",
    )

    # 派生子 Agent B
    agent_b = prototype.fork(
        role="Code Auditor",
        goal="Audit security boundaries in argument binders",
        specific_instructions="Check path-guard resolution strictly.",
    )

    # 核心前缀命中校验：两个子 Agent 的 system prompt 必须严格以相同的 base_prefix 开头
    assert isinstance(agent_a, SubagentInstance)
    assert isinstance(agent_a.config, SubagentConfig)
    assert agent_a.system_prompt.startswith(base_prefix)
    assert agent_b.system_prompt.startswith(base_prefix)

    # 角色特定指令必须置于后半部分，不篡改前置静态缓存前缀
    assert "Explorer" in agent_a.system_prompt
    assert "Focus on services/ directory only." in agent_a.system_prompt
    assert "Code Auditor" in agent_b.system_prompt
    assert "Check path-guard resolution strictly." in agent_b.system_prompt

    # 验证 run_id 唯一
    assert agent_a.run_id != agent_b.run_id
    assert agent_a.role == "Explorer"
    assert agent_b.role == "Code Auditor"


def test_tool_whitelist_filtering(tmp_path: Path):
    """验证 fork 时指定的 allowed_tools 白名单严格过滤工具集，未指定时继承母体全量工具。"""
    tools = _sample_tools()
    prototype = SubagentPrototype(
        system_prompt="Base Prompt",
        base_tools=tools,
        default_traces_dir=tmp_path / "logs" / "subagent_traces",
    )

    # 1. 继承全部工具
    agent_full = prototype.fork(role="General", goal="Full permissions")
    assert len(agent_full.tools) == 4
    assert [t["name"] for t in agent_full.tools] == [
        "read_file",
        "grep_search",
        "list_directory",
        "execute_command",
    ]

    # 2. 白名单过滤：只保留只读工具
    agent_readonly = prototype.fork(
        role="Reader",
        goal="Read only inspection",
        allowed_tools=["read_file", "list_directory"],
    )
    assert len(agent_readonly.tools) == 2
    tool_names = [t["name"] for t in agent_readonly.tools]
    assert "read_file" in tool_names
    assert "list_directory" in tool_names
    assert "execute_command" not in tool_names
    assert "grep_search" not in tool_names

    # 3. 白名单包含不存在的工具名称时安全过滤
    agent_safe = prototype.fork(
        role="Safe",
        goal="Safe tools",
        allowed_tools=["read_file", "non_existent_tool"],
    )
    assert len(agent_safe.tools) == 1
    assert agent_safe.tools[0]["name"] == "read_file"


def test_instance_state_machine_and_illegal_transitions(tmp_path: Path):
    """验证 SubagentInstance 状态机流转 (pending -> running -> completed/failed/cancelled)，拦截非法转换。"""
    traces_dir = tmp_path / "logs" / "subagent_traces"
    prototype = SubagentPrototype(
        system_prompt="Base",
        base_tools=_sample_tools(),
        default_traces_dir=traces_dir,
    )

    instance = prototype.fork(role="Worker", goal="Execute subtask")
    assert instance.status == "pending"

    # 未 start 直接 complete 应当抛出 ValueError
    with pytest.raises(ValueError, match="running|pending"):
        instance.complete(summary="Done too early")

    # 启动任务
    instance.start()
    assert instance.status == "running"

    # 重复 start 应当抛出 ValueError
    with pytest.raises(ValueError, match=r"(?i)already running|cannot start"):
        instance.start()

    # 记录单步
    instance.record_step(thought="Analyzing problem")

    # 正常完成
    res = instance.complete(
        summary="Task finished successfully",
        output={"files_found": 3},
        artifacts=["report.md"],
    )
    assert isinstance(res, SubagentResult)
    assert instance.status == "completed"
    assert res.status == "completed"
    assert res.summary == "Task finished successfully"
    assert res.output == {"files_found": 3}
    assert res.artifacts == ["report.md"]

    # 已终态后再次调用 complete / fail / cancel / start 必须被拦截
    with pytest.raises(ValueError, match="terminal|completed"):
        instance.complete(summary="Done again")

    with pytest.raises(ValueError, match="terminal|completed"):
        instance.fail(error="Failed after complete")

    with pytest.raises(ValueError, match="terminal|completed"):
        instance.cancel(reason="Cancel after complete")


def test_trace_isolator_step_ordering_and_structure(tmp_path: Path):
    """验证 TraceIsolator 严格单调递增 step_id，并无损落盘与反序列化解析。"""
    trace_file = tmp_path / "logs" / "subagent_traces" / "run_test_001.jsonl"
    isolator = TraceIsolator(run_id="run_test_001", trace_file=trace_file)

    assert isolator.get_total_steps() == 0
    assert not trace_file.exists()

    # 1. 记录思考链
    ev1 = isolator.record_thought("First, I will search for the configuration file.")
    assert isinstance(ev1, SubagentTraceEvent)
    assert ev1.step_id == 1
    assert ev1.event_type == "thought"
    assert ev1.payload["thought"] == "First, I will search for the configuration file."
    assert ev1.timestamp is not None

    # 2. 记录工具调用
    ev2 = isolator.record_tool_call(
        call_id="call_01",
        tool_name="grep_search",
        arguments={"pattern": "DB_CONNECTION"},
    )
    assert ev2.step_id == 2
    assert ev2.event_type == "tool_call"
    assert ev2.payload["call_id"] == "call_01"
    assert ev2.payload["tool_name"] == "grep_search"

    # 3. 记录工具结果
    ev3 = isolator.record_tool_result(
        call_id="call_01",
        tool_name="grep_search",
        result="Found 2 occurrences in config.py",
        ok=True,
    )
    assert ev3.step_id == 3
    assert ev3.event_type == "tool_result"
    assert ev3.payload["ok"] is True

    # 4. 记录错误
    ev4 = isolator.record_error("Permission denied when reading secret.key", error_type="PermissionError")
    assert ev4.step_id == 4
    assert ev4.event_type == "error"
    assert ev4.payload["error_type"] == "PermissionError"

    assert isolator.get_total_steps() == 4
    assert trace_file.exists()

    # 读取并反序列化验证
    events = isolator.read_trace()
    assert len(events) == 4
    assert [e.step_id for e in events] == [1, 2, 3, 4]
    assert [e.event_type for e in events] == ["thought", "tool_call", "tool_result", "error"]


def test_trace_isolator_event_type_filter(tmp_path: Path):
    """验证 read_trace 支持按 event_type 过滤审计。"""
    trace_file = tmp_path / "logs" / "subagent_traces" / "run_filter_test.jsonl"
    isolator = TraceIsolator(run_id="run_filter_test", trace_file=trace_file)

    isolator.record_thought("Thought 1")
    isolator.record_tool_call("c1", "read_file", {"path": "a.txt"})
    isolator.record_tool_result("c1", "read_file", "content a")
    isolator.record_thought("Thought 2")
    isolator.record_tool_call("c2", "read_file", {"path": "b.txt"})
    isolator.record_tool_result("c2", "read_file", "content b")
    isolator.record_error("Failed to read c.txt")

    # 仅读取 tool_call
    tool_calls = isolator.read_trace(event_type="tool_call")
    assert len(tool_calls) == 2
    assert all(e.event_type == "tool_call" for e in tool_calls)
    assert tool_calls[0].payload["call_id"] == "c1"
    assert tool_calls[1].payload["call_id"] == "c2"

    # 仅读取 error
    errors = isolator.read_trace(event_type="error")
    assert len(errors) == 1
    assert errors[0].event_type == "error"


def test_trace_isolation_zero_leakage_to_main_ledger(tmp_path: Path):
    """核心防污染铁律：子 Agent 密集的探索、思考与工具调用 100% 隔离写入子轨迹文件，绝对不泄漏到主日志。"""
    main_log_file = tmp_path / "logs" / "main_session_events.jsonl"
    subagent_traces_dir = tmp_path / "logs" / "subagent_traces"

    main_ledger = MainEventLedger(log_file=main_log_file)
    prototype = SubagentPrototype(
        system_prompt="Base Prompt",
        base_tools=_sample_tools(),
        default_traces_dir=subagent_traces_dir,
    )

    # 派生子 Agent 并执行 30 步繁杂操作
    subagent = prototype.fork(
        role="Heavy Explorer",
        goal="Crawl 50 files and extract tokens",
    )
    subagent.start()

    for i in range(1, 31):
        subagent.record_step(
            thought=f"Analyzing step {i} in subagent internal memory",
            tool_call={"call_id": f"call_{i}", "tool_name": "grep_search", "arguments": {"dir": f"dir_{i}"}},
            tool_result={"call_id": f"call_{i}", "tool_name": "grep_search", "result": f"Found heavy data for {i}"},
        )

    # 检查子 Agent 的轨迹文件
    subagent_trace_file = Path(subagent.isolator.trace_file)
    assert subagent_trace_file.exists()
    trace_lines = subagent_trace_file.read_text(encoding="utf-8").strip().splitlines()
    # 每个 step 包含 thought + tool_call + tool_result 共 3 条事件，30 步即 90 条（加上可选 lifecycle start 共 90 或 91 条）
    assert len(trace_lines) in (90, 91)

    # 核心铁律断言：主事件日志主账本绝对未受任何污染！
    # 主事件日志条数必须为 0，物理文件不存在或为空
    assert main_ledger.latest_seq_id == 0
    if main_log_file.exists():
        assert main_log_file.read_text(encoding="utf-8").strip() == ""


def test_backfeed_to_main_ledger_distilled_single_event(tmp_path: Path):
    """验证子 Agent 完成后，通过 backfeed_to_main_ledger 仅向主账本追加 1 条事实记录，且带物理路径指针。"""
    main_log_file = tmp_path / "logs" / "main_session_events.jsonl"
    subagent_traces_dir = tmp_path / "logs" / "subagent_traces"

    main_ledger = MainEventLedger(log_file=main_log_file)
    prototype = SubagentPrototype(
        system_prompt="Base Prompt",
        base_tools=_sample_tools(),
        default_traces_dir=subagent_traces_dir,
    )

    # 主事件日志中先有用户的初始需求
    ev_user = main_ledger.append_event(
        event_type="user",
        payload={"query": "请帮我全面排查系统安全边界与未用导出"},
    )
    assert ev_user.seq_id == 1

    # 派生子 Agent 执行审计
    subagent = prototype.fork(role="Security Auditor", goal="Audit system boundaries")
    subagent.start()

    # 子 Agent 内部进行大量探索
    for i in range(5):
        subagent.record_step(
            thought=f"Auditing chunk {i}",
            tool_call={"call_id": f"c_{i}", "tool_name": "read_file", "arguments": {"path": f"f_{i}.ts"}},
            tool_result={"call_id": f"c_{i}", "tool_name": "read_file", "result": "Clean, no leak"},
        )

    # 子 Agent 完成并生成浓缩结果
    result = subagent.complete(
        summary="经过 5 个核心模块审查，未发现任何安全边界逃逸现象，系统符合五层纵深策略。",
        output={"inspected_count": 5, "vulnerabilities": 0},
        artifacts=["security_report.json"],
    )

    # 将浓缩结论回灌主事件日志
    main_event = backfeed_to_main_ledger(ledger=main_ledger, result=result)

    # 核心断言 1：主事件日志新增且仅新增了 1 条事件
    assert main_event.seq_id == 2
    assert main_ledger.latest_seq_id == 2
    assert main_event.event_type == "subagent"
    assert main_event.subagent_run_id == subagent.run_id

    # 核心断言 2：主日志 payload 只存浓缩结论与 trace_file 指针，不存 15 条中间 step
    payload = main_event.payload
    assert payload["subagent_run_id"] == subagent.run_id
    assert payload["role"] == "Security Auditor"
    assert payload["status"] == "completed"
    assert "经过 5 个核心模块审查" in payload["summary"]
    assert payload["output"]["vulnerabilities"] == 0
    assert payload["artifacts"] == ["security_report.json"]
    assert "trace_file" in payload
    assert Path(payload["trace_file"]).exists()

    # 核心断言 3：主事件日志物理文件校验
    lines = main_log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    parsed_main_2 = json.loads(lines[1])
    assert parsed_main_2["event_type"] == "subagent"
    assert parsed_main_2["subagent_run_id"] == subagent.run_id
    assert "Auditing chunk" not in lines[1]  # 过程噪声绝不在主日志行内


def test_subagent_pool_management_and_finalize(tmp_path: Path):
    """验证 SubagentPool 统一管理子 Agent 实例并在完成时自动执行回灌。"""
    main_log_file = tmp_path / "logs" / "main_session_events.jsonl"
    subagent_traces_dir = tmp_path / "logs" / "subagent_traces"

    main_ledger = MainEventLedger(log_file=main_log_file)
    prototype = SubagentPrototype(
        system_prompt="Base Prompt",
        base_tools=_sample_tools(),
        default_traces_dir=subagent_traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    assert len(pool.list_all()) == 0
    assert len(pool.list_active()) == 0

    # 1. 孵化子 Agent
    agent1 = pool.spawn(role="Crawler", goal="Crawl site A")
    agent2 = pool.spawn(role="Indexer", goal="Index site A data")

    assert len(pool.list_all()) == 2
    assert len(pool.list_active()) == 2
    assert pool.get(agent1.run_id) is agent1
    assert pool.get(agent2.run_id) is agent2

    # 2. 执行 agent1
    agent1.start()
    agent1.record_step(thought="Crawling page 1")
    res1 = agent1.complete(summary="Crawled 10 pages successfully")

    # 3. 终结并自动回灌主账本
    backfed_event = pool.finalize(agent1.run_id, res1)
    assert backfed_event is not None
    assert backfed_event.event_type == "subagent"
    assert backfed_event.subagent_run_id == agent1.run_id

    # 检查池状态：agent1 已不再活跃，但仍可在 list_all 查询到
    assert len(pool.list_active()) == 1
    assert pool.list_active()[0].run_id == agent2.run_id
    assert len(pool.list_all()) == 2

    # 检查主账本
    assert main_ledger.latest_seq_id == 1
    events = main_ledger.read_events()
    assert len(events) == 1
    assert events[0].subagent_run_id == agent1.run_id


def test_concurrent_subagents_execution_isolation(tmp_path: Path):
    """高并发隔离测试：多线程同时派生子 Agent 并发写入，各自轨迹文件物理独立无竞争无串号。"""
    main_log_file = tmp_path / "logs" / "main_session_events.jsonl"
    subagent_traces_dir = tmp_path / "logs" / "subagent_traces"

    main_ledger = MainEventLedger(log_file=main_log_file)
    prototype = SubagentPrototype(
        system_prompt="Base Prefix",
        base_tools=_sample_tools(),
        default_traces_dir=subagent_traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    num_threads = 8
    steps_per_subagent = 15

    def worker_subagent(thread_idx: int):
        agent = pool.spawn(
            role=f"Worker_{thread_idx}",
            goal=f"Concurrent task {thread_idx}",
        )
        agent.start()
        for s in range(steps_per_subagent):
            agent.record_step(
                thought=f"Worker {thread_idx} thinking step {s}",
                tool_call={"call_id": f"c_{thread_idx}_{s}", "tool_name": "grep_search", "arguments": {"idx": s}},
                tool_result={"call_id": f"c_{thread_idx}_{s}", "tool_name": "grep_search", "result": f"res_{s}"},
            )
        res = agent.complete(
            summary=f"Worker {thread_idx} finished {steps_per_subagent} steps without issue.",
            output={"thread": thread_idx},
        )
        pool.finalize(agent.run_id, res)

    threads = [threading.Thread(target=worker_subagent, args=(i,)) for i in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 验证主账本：刚好 8 条子 Agent 浓缩回灌事件
    assert main_ledger.latest_seq_id == num_threads
    main_events = main_ledger.read_events()
    assert len(main_events) == num_threads

    seen_run_ids = set()
    for ev in main_events:
        assert ev.event_type == "subagent"
        assert ev.subagent_run_id is not None
        seen_run_ids.add(ev.subagent_run_id)
        # 验证每个回灌事件中指示的 trace_file 物理存在且内容完整
        trace_path = Path(ev.payload["trace_file"])
        assert trace_path.exists()
        lines = trace_path.read_text(encoding="utf-8").strip().splitlines()
        # 每个 step 包含 thought + tool_call + tool_result (3 条) + lifecycle start + complete (2 条) = 15*3 + 2 = 47 条
        assert len(lines) == steps_per_subagent * 3 + 2

    assert len(seen_run_ids) == num_threads


def test_subagent_failure_and_cancellation_handling(tmp_path: Path):
    """验证子 Agent 失败与取消场景，正确持久化错误轨迹并回灌主账本。"""
    main_log_file = tmp_path / "logs" / "main_session_events.jsonl"
    subagent_traces_dir = tmp_path / "logs" / "subagent_traces"

    main_ledger = MainEventLedger(log_file=main_log_file)
    prototype = SubagentPrototype(
        system_prompt="Base",
        base_tools=_sample_tools(),
        default_traces_dir=subagent_traces_dir,
    )
    pool = SubagentPool(prototype=prototype, ledger=main_ledger)

    # 1. 失败场景
    agent_fail = pool.spawn(role="Flaky Worker", goal="Try network request")
    agent_fail.start()
    agent_fail.record_step(thought="Connecting...")
    fail_res = agent_fail.fail(error="ConnectionRefusedError: port 8080 unavailable")

    assert fail_res.status == "failed"
    assert fail_res.error == "ConnectionRefusedError: port 8080 unavailable"
    ev_fail = pool.finalize(agent_fail.run_id, fail_res)
    assert ev_fail.payload["status"] == "failed"
    assert "ConnectionRefusedError" in ev_fail.payload["error"]

    # 2. 取消场景
    agent_cancel = pool.spawn(role="Long Running Worker", goal="Infinite loop")
    agent_cancel.start()
    agent_cancel.record_step(thought="Looping...")
    cancel_res = agent_cancel.cancel(reason="Timeout exceeded 30s")

    assert cancel_res.status == "cancelled"
    assert cancel_res.error == "Timeout exceeded 30s"
    ev_cancel = pool.finalize(agent_cancel.run_id, cancel_res)
    assert ev_cancel.payload["status"] == "cancelled"
    assert ev_cancel.payload["error"] == "Timeout exceeded 30s"

    # 主事件日志记录了这 2 条终态事件
    assert main_ledger.latest_seq_id == 2
