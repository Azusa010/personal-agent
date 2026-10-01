"""services/agent-runtime/tests/test_trajectory.py

针对 trajectory.py 的完整测试套件：
- compute_tool_fingerprint 规范化指纹计算与键排序不变性
- ToolFingerprintDetector 通用工具调用死循环与重复拦截
- DeathSpiralProtector 恢复深度计数、递归打断与上下文管理器
- repair_trajectory_integrity 轨迹配对完整性检测与孤儿调用合成修复
"""

import pytest

from personal_agent.conversation.loop.trajectory import (
    DeathSpiralError,
    DeathSpiralProtector,
    ToolFingerprintDetector,
    TrajectoryRepairReport,
    compute_tool_fingerprint,
    repair_trajectory_integrity,
)
from personal_agent.conversation.model.gateway import (
    Observation,
    ToolCallDecision,
    ToolCallItem,
)


def test_compute_tool_fingerprint_canonical():
    """验证工具指纹计算对参数字典的键顺序具有不变性，并区分不同参数。"""
    fp1 = compute_tool_fingerprint("filesystem_write", {"path": "/a/b.txt", "content": "hello"})
    fp2 = compute_tool_fingerprint("filesystem_write", {"content": "hello", "path": "/a/b.txt"})
    assert fp1 == fp2

    fp3 = compute_tool_fingerprint("filesystem_write", {"path": "/a/b.txt", "content": "world"})
    assert fp1 != fp3

    fp_empty = compute_tool_fingerprint("terminal_execute", {})
    fp_none = compute_tool_fingerprint("terminal_execute", None)
    assert fp_empty == fp_none


def test_tool_fingerprint_detector_distinct_calls():
    """验证正常的不同工具调用不会误报死循环。"""
    detector = ToolFingerprintDetector(consecutive_limit=2)

    is_loop, _ = detector.check_and_record("search", {"query": "apple"})
    assert not is_loop

    is_loop, _ = detector.check_and_record("search", {"query": "banana"})
    assert not is_loop

    is_loop, _ = detector.check_and_record("filesystem_read", {"path": "a.txt"})
    assert not is_loop


def test_tool_fingerprint_detector_consecutive_duplicates():
    """验证连续多次发起完全相同的工具调用时触发死循环报警。"""
    detector = ToolFingerprintDetector(consecutive_limit=2)

    is_loop, _ = detector.check_and_record("search", {"query": "apple"})
    assert not is_loop

    # 连续第 2 次相同调用：触发拦截
    is_loop, warning = detector.check_and_record("search", {"query": "apple"})
    assert is_loop
    assert warning is not None
    assert "连续多次" in warning
    assert "search" in warning


def test_tool_fingerprint_detector_reset():
    """验证 reset 方法清空指纹滑动窗口。"""
    detector = ToolFingerprintDetector(consecutive_limit=2)
    detector.check_and_record("search", {"query": "apple"})
    detector.reset()

    # 重置后首次调用不报警
    is_loop, _ = detector.check_and_record("search", {"query": "apple"})
    assert not is_loop


def test_death_spiral_protector_normal_depth():
    """验证在允许的最大恢复深度内正常进出与计数。"""
    protector = DeathSpiralProtector(max_depth=2)
    assert protector.depth == 0

    assert protector.enter() is True
    assert protector.depth == 1

    assert protector.enter() is True
    assert protector.depth == 2

    protector.exit()
    assert protector.depth == 1
    protector.exit()
    assert protector.depth == 0
    # 下界保持为 0
    protector.exit()
    assert protector.depth == 0


def test_death_spiral_protector_tripped_at_max_depth():
    """验证超过最大恢复深度时 enter 返回 False 拒绝进入。"""
    protector = DeathSpiralProtector(max_depth=2)
    protector.enter()  # depth 1
    protector.enter()  # depth 2
    # 超过上限 (depth 3 > max_depth 2)
    assert protector.enter() is False
    assert protector.depth == 3


def test_death_spiral_protector_guard_context_manager():
    """验证 guard 上下文管理器自动管理深度并在超限时抛出 DeathSpiralError。"""
    protector = DeathSpiralProtector(max_depth=1)

    with protector.guard():
        assert protector.depth == 1
        with pytest.raises(DeathSpiralError) as exc_info, protector.guard():
            pass  # 超限触发异常
        assert exc_info.value.depth == 2

    # 离开外层 guard 后深度恢复为 0
    assert protector.depth == 0


def test_repair_trajectory_integrity_empty():
    """验证空输入时返回空列表与空修复清单。"""
    report = repair_trajectory_integrity([], [])
    assert isinstance(report, TrajectoryRepairReport)
    assert report.repaired_observations == []
    assert report.repaired_call_ids == []
    assert not report.has_repaired


def test_repair_trajectory_integrity_already_paired():
    """验证所有工具调用均已有对应 Observation 时，原样保留且无修复。"""
    calls = [
        ToolCallItem(callId="call-1", capability="filesystem_list", arguments={"rootId": "home"}),
        ToolCallItem(callId="call-2", capability="filesystem_read", arguments={"path": "a.txt"}),
    ]
    obs1 = Observation(callId="call-1", capability="filesystem_list", ok=True, payload={"files": []})
    obs2 = Observation(callId="call-2", capability="filesystem_read", ok=True, payload={"text": "ok"})

    report = repair_trajectory_integrity(calls, [obs1, obs2])
    assert report.repaired_call_ids == []
    assert not report.has_repaired
    assert len(report.repaired_observations) == 2
    assert report.repaired_observations[0].callId == "call-1"
    assert report.repaired_observations[1].callId == "call-2"


def test_repair_trajectory_integrity_missing_single_observation():
    """验证单工具调用缺失 Observation 时自动生成 broken_trajectory 合成错误观察。"""
    call1 = ToolCallDecision(
        kind="tool_call",
        callId="call-1",
        capability="filesystem_write",
        arguments={"path": "out.txt", "content": "123"},
    )
    call2 = ToolCallDecision(
        kind="tool_call",
        callId="call-2",
        capability="terminal_execute",
        arguments={"command": "dir"},
    )
    # 只有 call1 存在对应 Observation
    obs1 = Observation(
        callId="call-1",
        capability="filesystem_write",
        ok=True,
        payload={"bytesWritten": 3},
        arguments={"path": "out.txt", "content": "123"},
    )

    report = repair_trajectory_integrity([call1, call2], [obs1])
    assert report.has_repaired
    assert report.repaired_call_ids == ["call-2"]
    assert len(report.repaired_observations) == 2

    # 原有观察保持原样
    assert report.repaired_observations[0] == obs1

    # 缺失的 call-2 获得合成补齐
    repaired_obs2 = report.repaired_observations[1]
    assert repaired_obs2.callId == "call-2"
    assert repaired_obs2.capability == "terminal_execute"
    assert repaired_obs2.ok is False
    assert repaired_obs2.payload.get("error") == "broken_trajectory"
    assert "配对" in repaired_obs2.payload.get("reason", "")
    assert repaired_obs2.arguments == {"command": "dir"}


def test_repair_trajectory_integrity_batch_calls_multiple_missing():
    """验证批量工具调用中多条缺失 Observation 时的完整修补与顺序保持。"""
    calls = [
        ToolCallItem(callId="batch-1", capability="cap1", arguments={"x": 1}),
        ToolCallItem(callId="batch-2", capability="cap2", arguments={"x": 2}),
        ToolCallItem(callId="batch-3", capability="cap3", arguments={"x": 3}),
    ]
    # 只有 batch-2 返回了 Observation
    obs2 = Observation(callId="batch-2", capability="cap2", ok=True, payload={"result": "ok"})

    report = repair_trajectory_integrity(calls, [obs2])
    assert report.repaired_call_ids == ["batch-1", "batch-3"]
    assert len(report.repaired_observations) == 3

    # 保证顺序严格与 calls 的 callId 顺序一致：batch-1, batch-2, batch-3
    assert [o.callId for o in report.repaired_observations] == ["batch-1", "batch-2", "batch-3"]
    assert report.repaired_observations[0].ok is False
    assert report.repaired_observations[1] == obs2
    assert report.repaired_observations[2].ok is False


def test_repair_trajectory_integrity_preserves_unlisted_observations():
    """验证 observations 中若存在不在 tool_calls 列表中的额外观测，追加在末尾防止信息丢失。"""
    calls = [
        ToolCallItem(callId="c1", capability="cap1", arguments={}),
    ]
    obs1 = Observation(callId="c1", capability="cap1", ok=True, payload={})
    extra_obs = Observation(callId="extra-orphan", capability="cap_other", ok=True, payload={"info": "kept"})

    report = repair_trajectory_integrity(calls, [obs1, extra_obs])
    assert report.repaired_call_ids == []
    assert len(report.repaired_observations) == 2
    assert report.repaired_observations[0] == obs1
    assert report.repaired_observations[1] == extra_obs
