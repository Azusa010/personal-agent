"""services/agent-runtime/tests/test_sliding_window.py

测试网：高水位滑动窗口与时间门卫（Working RAM & Time Gatekeeper）。
验证：
1. 70% 高水位触发线与 Token 预算计算 (Watermark Ratio & Token Budget)
2. 成对工具保护铁律 (Pairing Boundary Preservation)：绝对不截断在 tool_call 与 tool_result 之间
3. 最小保留轮数保障 (Minimum Preserved User Turns)
4. 滑动滚褶与滚动任务摘要自动折叠 (Compaction & Rolling Task Summary)
5. 时间门卫超时判定与 Epoch 软重置 (Time Gatekeeper Timeout & Epoch Shift)
6. 过渡桥梁缓冲区 (Bridge Buffer)：跨夜后保留最近 2 轮对话无缝衔接
7. 现场召回工具 (recall_epoch)：无损读取历史草稿归档
8. 综合全生命周期流转 (Full Compaction & Time Gatekeeper Integration)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.windows import (
    ActiveWindowSnapshot,
    EpochArchive,
    SlidingWindowLedger,
    TimeGatekeeper,
    WindowConfig,
    recall_epoch,
)


def _seed_sample_conversation(
    ledger: MainEventLedger,
    num_turns: int = 8,
    include_tools: bool = True,
) -> None:
    """辅助方法：向主账本中注入标准的多轮用户对话与成对工具调用。"""
    for i in range(1, num_turns + 1):
        # 1. User Turn
        ledger.append_event(
            event_type="user",
            payload={"text": f"User query for task step {i}: analyze component {i}"},
        )
        # 2. Assistant Turn with optional tool call
        if include_tools:
            call_id = f"call_step_{i}"
            ledger.append_event(
                event_type="tool_call",
                payload={"call_id": call_id, "tool_name": "inspect_code", "arguments": {"target": f"file_{i}.ts"}},
            )
            ledger.append_event(
                event_type="tool_result",
                payload={"call_id": call_id, "tool_name": "inspect_code", "result": f"Component {i} syntax is valid."},
            )
        ledger.append_event(
            event_type="assistant",
            payload={"text": f"Completed analysis for step {i} successfully."},
        )


def test_window_config_defaults_and_token_calculation(tmp_path: Path):
    """验证 WindowConfig 默认参数（70% 水位、100K 预算、6 轮保留、5 小时超时）与配置覆盖。"""
    cfg_default = WindowConfig()
    assert cfg_default.max_budget_tokens == 100_000
    assert cfg_default.high_watermark_ratio == 0.7
    assert cfg_default.min_preserved_turns == 6
    assert cfg_default.inactivity_threshold_seconds == 5 * 3600

    cfg_custom = WindowConfig(
        max_budget_tokens=20_000,
        high_watermark_ratio=0.75,
        min_preserved_turns=3,
        inactivity_threshold_seconds=7200,
        epochs_dir=tmp_path / "epochs",
    )
    assert cfg_custom.max_budget_tokens == 20_000
    assert cfg_custom.high_watermark_ratio == 0.75
    assert cfg_custom.min_preserved_turns == 3
    assert cfg_custom.inactivity_threshold_seconds == 7200
    assert cfg_custom.epochs_dir == tmp_path / "epochs"


def test_active_window_retrieval_and_snapshot(tmp_path: Path):
    """验证 get_active_window 正确返回当前活动窗口的事件、滚动摘要与 Token 统计。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    _seed_sample_conversation(ledger=ledger, num_turns=3, include_tools=True)
    assert ledger.latest_seq_id == 12  # 每轮 4 条事件 (user, tool_call, tool_result, assistant) * 3 = 12

    snapshot = window.get_active_window()
    assert isinstance(snapshot, ActiveWindowSnapshot)
    assert snapshot.window_watermark == 0
    assert len(snapshot.events) == 12
    assert snapshot.total_tokens > 0
    assert snapshot.rolling_task_summary == ""
    assert snapshot.epoch_id == 1


def test_pairing_boundary_detector_never_splits_tool_pairs(tmp_path: Path):
    """核心防爆铁律：切分边界绝对不能切断在 tool_call 与 tool_result 中间，必须成对保留或成对折叠。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    # 注入包含成对工具调用的对话
    _seed_sample_conversation(ledger=ledger, num_turns=5, include_tools=True)
    events = ledger.read_events()

    # 扫描每一对可能切分的边界点
    # 验证 find_safe_compaction_boundary 针对任何 target_keep_turns 返回的 boundary_seq_id：
    # 绝不能是 tool_call 的下一个（即绝不能让 tool_call 被折叠而保留了孤立的 tool_result）
    for keep_turns in [1, 2, 3, 4]:
        boundary_seq_id = window.find_safe_compaction_boundary(events=events, target_keep_turns=keep_turns)
        
        # 获取切分点前后的事件
        kept_events = [e for e in events if e.seq_id > boundary_seq_id]
        compacted_events = [e for e in events if e.seq_id <= boundary_seq_id]

        # 校验 1：保留区（Kept Events）如果包含 tool_result，其对应的 tool_call 必须同时在保留区
        kept_tool_result_calls = {
            e.payload.get("call_id") for e in kept_events if e.event_type == "tool_result"
        }
        kept_tool_call_ids = {
            e.payload.get("call_id") for e in kept_events if e.event_type == "tool_call"
        }
        assert kept_tool_result_calls.issubset(kept_tool_call_ids), (
            f"Orphaned tool_result detected in active window! Call IDs: {kept_tool_result_calls - kept_tool_call_ids}"
        )

        # 校验 2：折叠区（Compacted Events）如果包含 tool_call，其 tool_result 也必须在折叠区
        compacted_tool_calls = {
            e.payload.get("call_id") for e in compacted_events if e.event_type == "tool_call"
        }
        compacted_tool_results = {
            e.payload.get("call_id") for e in compacted_events if e.event_type == "tool_result"
        }
        assert compacted_tool_calls.issubset(compacted_tool_results), (
            f"Dangling tool_call separated from tool_result in compaction! Call IDs: {compacted_tool_calls - compacted_tool_results}"
        )


def test_high_watermark_trigger_and_compaction(tmp_path: Path):
    """验证当 Token 达到 70% 水位线时触发自动滚褶，旧事件折叠进 rolling_task_summary，游标推进。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    # 设置较小的预算以触发 70% 水位（如 2000 token，70% 为 1400 token）
    config = WindowConfig(
        max_budget_tokens=1500,
        high_watermark_ratio=0.7,
        min_preserved_turns=2,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)

    # 1. 注入 3 轮较短对话，未超过 1050 token (1500 * 0.7)
    _seed_sample_conversation(ledger=ledger, num_turns=3, include_tools=False)
    triggered_under = window.compact_if_needed()
    assert triggered_under is False
    assert window.window_watermark == 0
    assert window.rolling_task_summary == ""

    # 2. 注入多轮大篇幅对话，大幅打穿 70% 高水位线
    for i in range(4, 12):
        ledger.append_event(
            event_type="user",
            payload={"text": f"User query {i}: " + "Detailed instructions and context " * 20},
        )
        ledger.append_event(
            event_type="assistant",
            payload={"text": f"Assistant response {i}: " + "Comprehensive analysis result " * 20},
        )

    before_snapshot = window.get_active_window()
    assert before_snapshot.total_tokens > 1050  # 超过 70% 警戒线

    # 3. 执行滚褶压缩
    def dummy_summarizer(compacted_events: list[Any], old_summary: str) -> str:
        return f"{old_summary} [Compacted {len(compacted_events)} earlier events up to turn 9]".strip()

    triggered = window.compact_if_needed(summarizer_fn=dummy_summarizer)
    assert triggered is True
    assert window.window_watermark > 0
    assert "Compacted" in window.rolling_task_summary

    # 校验压缩后活跃窗口状态
    after_snapshot = window.get_active_window()
    assert after_snapshot.window_watermark == window.window_watermark
    assert len(after_snapshot.events) < len(before_snapshot.events)
    # 保证至少保留了配置的 min_preserved_turns (2 轮)
    user_turns_kept = sum(1 for e in after_snapshot.events if e.event_type == "user")
    assert user_turns_kept >= 2


def test_min_preserved_turns_enforcement(tmp_path: Path):
    """验证即使在超大 Token 压力下，算法依然坚决保留最近 min_preserved_turns 轮完整 User Turn。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    config = WindowConfig(
        max_budget_tokens=500,
        high_watermark_ratio=0.5,
        min_preserved_turns=4,  # 要求坚守至少 4 轮
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)

    _seed_sample_conversation(ledger=ledger, num_turns=8, include_tools=True)
    window.compact_if_needed()

    snapshot = window.get_active_window()
    user_events = [e for e in snapshot.events if e.event_type == "user"]
    assert len(user_events) >= 4
    # 验证保留的是最近的 4 轮 (步骤 5, 6, 7, 8)
    assert "task step 8" in user_events[-1].payload["text"]
    assert "task step 7" in user_events[-2].payload["text"]


def test_time_gatekeeper_normal_interaction_no_timeout(tmp_path: Path):
    """验证在正常时间间隔内（未达超时阈值），时间门卫不触发归档，不重置上下文。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    config = WindowConfig(inactivity_threshold_seconds=1800)  # 30 分钟
    window = SlidingWindowLedger(ledger=ledger, config=config)
    gatekeeper = TimeGatekeeper(window=window, config=config)

    start_time = 1_000_000.0
    gatekeeper.record_interaction(timestamp=start_time)

    _seed_sample_conversation(ledger=ledger, num_turns=2)

    # 10 分钟后用户继续回复（未超时）
    next_time = start_time + 600.0
    archive = gatekeeper.check_and_handle_timeout(current_timestamp=next_time)

    assert archive is None
    assert ledger.current_epoch_id == 1
    assert window.window_watermark == 0
    assert not (tmp_path / "epochs").exists() or len(list((tmp_path / "epochs").glob("*.md"))) == 0


def test_time_gatekeeper_overnight_timeout_epoch_shift_and_archive(tmp_path: Path):
    """验证超时隔夜场景：触发软重置、归档旧纪元到 Markdown、自增 epoch_id、重置摘要为系统提示。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    config = WindowConfig(
        inactivity_threshold_seconds=5 * 3600,  # 5 小时
        epochs_dir=epochs_dir,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)
    gatekeeper = TimeGatekeeper(window=window, config=config)

    # 初始对话并设置摘要
    window.rolling_task_summary = "前置任务：排查了登录认证模块的 JWT Token 校验问题。"
    _seed_sample_conversation(ledger=ledger, num_turns=6, include_tools=True)

    start_time = 1_000_000.0
    gatekeeper.record_interaction(timestamp=start_time)

    # 模拟 8 小时后（跨夜隔天）用户发起新交互
    next_morning_time = start_time + 8 * 3600.0
    archive = gatekeeper.check_and_handle_timeout(current_timestamp=next_morning_time)

    assert archive is not None
    assert isinstance(archive, EpochArchive)
    assert archive.epoch_id == 1
    assert archive.time_elapsed_seconds == 8 * 3600.0
    assert Path(archive.file_path).exists()

    # 验证新纪元状态
    assert ledger.current_epoch_id == 2
    assert "epoch_1_summary.md" in archive.file_path

    # 验证生成的归档 Markdown 文件内容
    archived_md = Path(archive.file_path).read_text(encoding="utf-8")
    assert "Epoch 1 归档快照" in archived_md or "Epoch 1 Summary" in archived_md or "JWT Token" in archived_md
    assert "登录认证模块" in archived_md

    # 验证 rolling_task_summary 被重置为友好的系统引导语
    assert "系统提示" in window.rolling_task_summary or "System Notice" in window.rolling_task_summary
    assert "recall_epoch" in window.rolling_task_summary
    assert "epoch_1" in window.rolling_task_summary


def test_time_gatekeeper_bridge_buffer_preservation(tmp_path: Path):
    """验证过渡桥梁缓冲区 (Bridge Buffer)：超时后绝非粗暴清空全部上下文，而是保留最近 2 轮对话。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)
    config = WindowConfig(
        inactivity_threshold_seconds=3600,
        epochs_dir=epochs_dir,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)
    gatekeeper = TimeGatekeeper(window=window, config=config)

    # 注入 5 轮对话
    _seed_sample_conversation(ledger=ledger, num_turns=5, include_tools=False)
    gatekeeper.record_interaction(timestamp=1000.0)

    # 超时 2 小时
    gatekeeper.check_and_handle_timeout(current_timestamp=1000.0 + 7200.0)

    # 校验 Bridge Buffer：window_watermark 自动推进，恰好保留最近 2 轮 User Turn
    snapshot = window.get_active_window()
    kept_users = [e for e in snapshot.events if e.event_type == "user"]
    assert len(kept_users) == 2
    assert "task step 4" in kept_users[0].payload["text"]
    assert "task step 5" in kept_users[1].payload["text"]


def test_recall_epoch_tool_success_and_missing_file(tmp_path: Path):
    """验证 recall_epoch 现场召回工具可无损还原旧任务快照，面对不存在的文件能抛出明确错误。"""
    epochs_dir = tmp_path / "epochs"
    epochs_dir.mkdir(parents=True, exist_ok=True)

    test_file = epochs_dir / "epoch_1_summary.md"
    test_content = "# 任务纪元 1 归档\n核心结论：已重构完成五层纵深拦截网并跑通 10 项测试。"
    test_file.write_text(test_content, encoding="utf-8")

    # 1. 成功召回
    recalled = recall_epoch("epoch_1_summary.md", epochs_dir=epochs_dir)
    assert recalled == test_content
    assert "五层纵深拦截网" in recalled

    # 2. 召回不存在的文件抛出 FileNotFoundError
    with pytest.raises(FileNotFoundError, match="epoch_999"):
        recall_epoch("epoch_999_summary.md", epochs_dir=epochs_dir)


def test_full_lifecycle_compaction_timeout_and_recall_integration(tmp_path: Path):
    """端到端综合测试：70% 高水位滚褶 -> 跨夜超时归档 -> 新纪元流转 -> Bridge Buffer 桥接 -> 现场召回。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    epochs_dir = tmp_path / "epochs"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)

    config = WindowConfig(
        max_budget_tokens=600,
        high_watermark_ratio=0.7,
        min_preserved_turns=3,
        inactivity_threshold_seconds=10_000,
        epochs_dir=epochs_dir,
    )
    window = SlidingWindowLedger(ledger=ledger, config=config)
    gatekeeper = TimeGatekeeper(window=window, config=config)

    # 阶段 1：高密度对话触发 70% 水位滚褶
    gatekeeper.record_interaction(timestamp=100_000.0)
    for i in range(1, 10):
        ledger.append_event(event_type="user", payload={"text": f"Turn {i}: " + "Data payload " * 15})
        ledger.append_event(event_type="assistant", payload={"text": f"Reply {i}: " + "Status analysis " * 15})

    assert window.compact_if_needed() is True
    assert window.window_watermark > 0

    # 阶段 2：模拟跨夜 15,000 秒后触发 Epoch 切换
    archive = gatekeeper.check_and_handle_timeout(current_timestamp=100_000.0 + 15_000.0)
    assert archive is not None
    assert ledger.current_epoch_id == 2

    # 阶段 3：在新纪元写入新任务，保留 Bridge Buffer
    snapshot_new_epoch = window.get_active_window()
    assert len(snapshot_new_epoch.events) >= 2  # 存在过渡缓冲
    ledger.append_event(event_type="user", payload={"text": "新的一天，开启新模块重构"})
    ledger.append_event(event_type="assistant", payload={"text": "收到，基于昨天的进展无缝接续。"})

    # 阶段 4：模型调用 recall_epoch 唤醒昨日归档
    archive_name = Path(archive.file_path).name
    recalled_yesterday = recall_epoch(archive_name, epochs_dir=epochs_dir)
    assert len(recalled_yesterday) > 0
