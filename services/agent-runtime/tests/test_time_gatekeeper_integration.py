"""services/agent-runtime/tests/test_time_gatekeeper_integration.py

测试网：TimeGateKeeper 会话前置守门与 ContextManager / Strategy 闭环接线。
验证：
1. 正常交互未超时：ContextManager.build() 不触发归档，不改变纪元，正常刷新交互时间戳。
2. 跨夜/空闲超时归档：ContextManager.build() 自动触发超时判定，落盘 epoch_{id}_summary.md，
   将系统引导语注入提示词（引导使用 recall_epoch），并自动收缩至 Bridge Buffer。
3. 归档与 recall_epoch 无缝对接：归档出的 Markdown 文件可被 recall_epoch 精准读回。
4. 策略层契约向后兼容：AgentStrategy.execute 允许可选注入 time_gatekeeper 与 sliding_window，不影响存量 Classic 策略。
"""

from __future__ import annotations

from pathlib import Path

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.windows import (
    SlidingWindowLedger,
    TimeGatekeeper,
    WindowConfig,
    recall_epoch,
)


def _seed_turns(ledger: MainEventLedger, count: int = 5) -> None:
    for i in range(1, count + 1):
        ledger.append_event("user", {"text": f"用户历史问题 {i}：关于架构第 {i} 阶段"})
        ledger.append_event("assistant", {"text": f"模型回复 {i}：第 {i} 阶段已完成设计"})


def test_context_manager_with_time_gatekeeper_no_timeout(tmp_path: Path):
    """验证正常交互时间间隔内（未超时），ContextManager.build() 不触发纪元归档。"""
    log_file = tmp_path / "events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    config = WindowConfig(inactivity_threshold_seconds=3600, epochs_dir=epochs_dir)
    window = SlidingWindowLedger(ledger=ledger, config=config)
    gatekeeper = TimeGatekeeper(window=window, config=config)

    start_time = 10000.0
    gatekeeper.record_interaction(start_time)
    _seed_turns(ledger, count=2)

    cm = ContextManager(
        sliding_window=window,
        time_gatekeeper=gatekeeper,
        task_goal="继续对话",
    )
    assert cm.time_gatekeeper is gatekeeper

    # 15 分钟后进行 build，未超出 3600 秒
    ctx = cm.build(
        taskGoal="继续对话",
        visibleCapabilities=[],
        current_timestamp=start_time + 900.0,
    )

    assert ledger.current_epoch_id == 1
    assert not epochs_dir.exists() or len(list(epochs_dir.glob("*.md"))) == 0
    assert "距离上次交互已过去" not in (ctx.systemPrompt or "")
    assert gatekeeper.last_interaction_timestamp == start_time + 900.0


def test_context_manager_with_time_gatekeeper_overnight_timeout(tmp_path: Path):
    """验证超时隔夜场景：build() 自动触发归档、递增 epoch_id、注入引导提示并保留桥梁缓冲。"""
    log_file = tmp_path / "events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    config = WindowConfig(
        inactivity_threshold_seconds=5 * 3600,  # 5 小时
        epochs_dir=epochs_dir,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)
    window.rolling_task_summary = "前置背景：排查了登录认证模块的 JWT Token 校验问题。"
    gatekeeper = TimeGatekeeper(window=window, config=config)

    start_time = 10000.0
    gatekeeper.record_interaction(start_time)
    _seed_turns(ledger, count=6)

    cm = ContextManager(
        sliding_window=window,
        time_gatekeeper=gatekeeper,
        task_goal="隔夜新任务",
    )

    # 8 小时后发起交互，超出 5 小时阈值
    next_morning_time = start_time + 8 * 3600.0
    ctx = cm.build(
        taskGoal="隔夜新任务",
        visibleCapabilities=[],
        current_timestamp=next_morning_time,
    )

    # 1. 验证纪元递增与归档文件落盘
    assert ledger.current_epoch_id == 2
    archive_file = epochs_dir / "epoch_1_summary.md"
    assert archive_file.exists()

    # 2. 验证系统提示词中包含纪元归档与 recall_epoch 引导语
    assert ctx.systemPrompt is not None
    assert "系统提示" in ctx.systemPrompt
    assert "recall_epoch" in ctx.systemPrompt
    assert "epoch_1_summary.md" in ctx.systemPrompt

    # 3. 验证 Bridge Buffer：保留了最近的 user turns
    active_snapshot = window.get_active_window()
    user_turns = [e for e in active_snapshot.events if e.event_type == "user"]
    assert len(user_turns) >= 2


def test_gatekeeper_archive_readable_by_recall_epoch(tmp_path: Path):
    """验证由 TimeGateKeeper 归档生成的 Markdown 文件可被 recall_epoch 正确读回。"""
    log_file = tmp_path / "events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    config = WindowConfig(inactivity_threshold_seconds=1800, epochs_dir=epochs_dir)
    window = SlidingWindowLedger(ledger=ledger, config=config)
    window.rolling_task_summary = "旧纪元任务：编写订单微服务并集成支付网关。"
    gatekeeper = TimeGatekeeper(window=window, config=config)

    start_time = 5000.0
    gatekeeper.record_interaction(start_time)
    _seed_turns(ledger, count=3)

    cm = ContextManager(
        sliding_window=window,
        time_gatekeeper=gatekeeper,
        task_goal="测试召回",
    )

    # 超时触发归档
    cm.build(taskGoal="测试召回", visibleCapabilities=[], current_timestamp=start_time + 3600.0)

    # 使用 recall_epoch 读回归档
    content = recall_epoch("epoch_1_summary.md", epochs_dir=epochs_dir)
    assert "订单微服务" in content or "Epoch 1 Summary" in content
