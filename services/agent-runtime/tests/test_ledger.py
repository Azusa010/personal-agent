"""services/agent-runtime/tests/test_ledger.py

测试网：不可变主事件日志（Single Source of Truth）与防爆门卫（Ledger Guard / Blob Offloader）。
验证：
1. 严格单调递增 seq_id 与多实例断点恢复续写
2. 剥离 thinking 思考链保证主事件日志精简
3. 纪元 epoch_id 跟踪与流转
4. 超限工具结果自动脱水落盘为 Blob 指针（Head/Tail Preview 保留）
5. 兜底历史深层检索工具（关键词/正则、逆序、按类型过滤）
6. 多线程并发追加写入安全性与行原子性
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import pytest

from personal_agent.conversation.ledger import (
    BlobPointer,
    LedgerGuard,
    MainEventLedger,
    search_raw_event_log,
)


def test_monotonic_seq_id_and_structure(tmp_path: Path):
    """验证 seq_id 严格从 1 递增，且事件结构完整规范。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    assert ledger.latest_seq_id == 0
    assert ledger.current_epoch_id == 1

    ev1 = ledger.append_event(
        event_type="user",
        payload={"text": "你好，请帮我排查代码"},
    )
    assert ev1.seq_id == 1
    assert ev1.epoch_id == 1
    assert ev1.event_type == "user"
    assert ev1.payload["text"] == "你好，请帮我排查代码"
    assert ev1.timestamp is not None
    assert ledger.latest_seq_id == 1

    ev2 = ledger.append_event(
        event_type="assistant",
        payload={"text": "收到，我将首先检查配置"},
    )
    assert ev2.seq_id == 2
    assert ev2.epoch_id == 1
    assert ledger.latest_seq_id == 2

    # 检查物理文件内容
    assert log_file.exists()
    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2

    parsed1 = json.loads(lines[0])
    assert parsed1["seq_id"] == 1
    assert parsed1["event_type"] == "user"

    parsed2 = json.loads(lines[1])
    assert parsed2["seq_id"] == 2
    assert parsed2["event_type"] == "assistant"


def test_persistence_and_resume(tmp_path: Path):
    """验证重启实例后能够正确从已存在的文件加载最新 seq_id，无缝接续自增。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"

    ledger1 = MainEventLedger(log_file=log_file)
    ledger1.append_event(event_type="user", payload={"msg": "first"})
    ledger1.append_event(event_type="assistant", payload={"msg": "second"})
    assert ledger1.latest_seq_id == 2

    # 新实例加载同一日志文件
    ledger2 = MainEventLedger(log_file=log_file)
    assert ledger2.latest_seq_id == 2

    ev3 = ledger2.append_event(event_type="tool_call", payload={"name": "run_test"})
    assert ev3.seq_id == 3
    assert ledger2.latest_seq_id == 3

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    assert json.loads(lines[2])["seq_id"] == 3


def test_thinking_stripping(tmp_path: Path):
    """验证已结束轮次的思考链 (thinking) 会被绝对剥离，不污染不可变主事件日志。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    ev = ledger.append_event(
        event_type="assistant",
        payload={
            "text": "这是最终给用户的回答",
            "thinking": "这里是数千字的内部思考链过程，绝不可存入主日志",
        },
    )

    assert "thinking" not in ev.payload
    assert ev.payload["text"] == "这是最终给用户的回答"

    # 检查持久化物理文件
    raw_text = log_file.read_text(encoding="utf-8")
    assert "内部思考链过程" not in raw_text


def test_epoch_id_tracking_and_transition(tmp_path: Path):
    """验证任务纪元 (epoch_id) 跟踪与流转，严格单调非递减。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file, initial_epoch_id=1)

    ev1 = ledger.append_event(event_type="user", payload={"text": "任务 A"})
    assert ev1.epoch_id == 1

    # 切换至纪元 2（如话题切换或隔夜重置）
    ledger.set_epoch_id(2)
    assert ledger.current_epoch_id == 2

    ev2 = ledger.append_event(event_type="user", payload={"text": "任务 B"})
    assert ev2.seq_id == 2
    assert ev2.epoch_id == 2

    # 非法逆流或负数纪元应当抛出 ValueError
    with pytest.raises(ValueError, match="epoch_id"):
        ledger.set_epoch_id(1)

    with pytest.raises(ValueError, match="epoch_id"):
        ledger.set_epoch_id(-1)


def test_read_events_filtering(tmp_path: Path):
    """验证 read_events 支持 since_seq_id、epoch_id 与 limit 灵活过滤。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    for i in range(1, 11):
        if i > 5:
            ledger.set_epoch_id(2)
        ledger.append_event(
            event_type="tool_call" if i % 2 == 0 else "tool_result",
            payload={"index": i},
        )

    assert ledger.latest_seq_id == 10

    # 1. 过滤 since_seq_id
    since_6 = ledger.read_events(since_seq_id=6)
    assert len(since_6) == 4
    assert [e.seq_id for e in since_6] == [7, 8, 9, 10]

    # 2. 限制 limit
    first_3 = ledger.read_events(since_seq_id=0, limit=3)
    assert len(first_3) == 3
    assert [e.seq_id for e in first_3] == [1, 2, 3]

    # 3. 按 epoch_id 过滤
    epoch1_events = ledger.read_events(epoch_id=1)
    assert len(epoch1_events) == 5
    assert all(e.epoch_id == 1 for e in epoch1_events)

    epoch2_events = ledger.read_events(epoch_id=2)
    assert len(epoch2_events) == 5
    assert all(e.epoch_id == 2 for e in epoch2_events)


def test_blob_offloader_under_threshold(tmp_path: Path):
    """未超过防爆阈值的工具结果保持内联，不进行落盘脱水。"""
    blob_dir = tmp_path / "logs" / "offloaded_blobs"
    guard = LedgerGuard(blob_dir=blob_dir, preview_chars=200, max_chars=1000)

    short_payload = {"output": "正常小体积输出", "code": 0}
    guarded_payload, pointer = guard.guard_tool_result(
        call_id="call_101",
        capability="execute_command",
        ok=True,
        payload=short_payload,
    )

    assert pointer is None
    call_id_val = guarded_payload.get("callId") or guarded_payload.get("call_id")
    assert call_id_val == "call_101"
    assert guarded_payload["capability"] == "execute_command"
    assert guarded_payload["ok"] is True
    assert guarded_payload.get("offloaded") is not True
    assert guarded_payload["payload"] == short_payload
    assert not blob_dir.exists() or len(list(blob_dir.glob("*.txt"))) == 0


def test_blob_offloader_over_threshold(tmp_path: Path):
    """超过阈值的超大工具输出被自动剥离落盘，保留 Head/Tail 预览和指针。"""
    blob_dir = tmp_path / "logs" / "offloaded_blobs"
    guard = LedgerGuard(
        blob_dir=blob_dir,
        preview_chars=200,
        max_chars=500,
    )

    # 构造一个 50 行的超大日志文本
    lines = [f"Line {i:03d}: Some heavy output message from compiler or test runner" for i in range(1, 51)]
    large_text = "\n".join(lines)
    assert len(large_text) > 1000

    guarded_payload, pointer = guard.guard_tool_result(
        call_id="call_big_1",
        capability="run_command",
        ok=True,
        payload=large_text,
    )

    assert pointer is not None
    assert isinstance(pointer, BlobPointer)
    assert pointer.blob_id.startswith("blob_")
    assert Path(pointer.file_path).exists()
    assert pointer.original_chars == len(large_text)
    assert pointer.estimated_chars > 0

    # 验证完整数据已无损写入落盘文件
    raw_saved = Path(pointer.file_path).read_text(encoding="utf-8")
    assert raw_saved == large_text

    # 验证预览包含 Head 与 Tail 以及省略提示
    preview = pointer.preview
    assert "Line 001:" in preview
    assert "Line 050:" in preview
    assert "truncated" in preview.lower() or "..." in preview or "截断" in preview

    # 验证 guarded_payload 携带脱水指针结构
    call_id_val = guarded_payload.get("callId") or guarded_payload.get("call_id")
    assert call_id_val == "call_big_1"
    assert guarded_payload["offloaded"] is True
    blob_id_val = guarded_payload.get("blobId") or guarded_payload.get("blob_id")
    assert blob_id_val == pointer.blob_id
    file_path_val = guarded_payload.get("filePath") or guarded_payload.get("file_path")
    assert file_path_val == pointer.file_path
    assert guarded_payload["preview"] == preview
    assert guarded_payload["original_chars"] == len(large_text)


def test_blob_offloader_read_blob(tmp_path: Path):
    """验证通过 BlobOffloader.read_blob 可以精确恢复 100% 原始数据。"""
    blob_dir = tmp_path / "logs" / "offloaded_blobs"
    guard = LedgerGuard(blob_dir=blob_dir, preview_chars=100, max_chars=100)

    raw_content = "Super long content that must be safely offloaded to disk and read back lossless." * 10
    _, pointer = guard.guard_tool_result(
        call_id="call_read_1",
        capability="cat_file",
        ok=True,
        payload=raw_content,
    )
    assert pointer is not None

    # 按 blob_id 读取
    restored1 = guard.read_blob(pointer.blob_id)
    assert restored1 == raw_content

    # 按 file_path 读取
    restored2 = guard.read_blob(pointer.file_path)
    assert restored2 == raw_content


def test_search_raw_event_log_plain_and_reverse(tmp_path: Path):
    """验证兜底检索工具按时间倒序（最新的先命中）与关键词命中。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    ledger.append_event(
        event_type="user",
        payload={"query": "请帮我订一张前往东京的机票"},
    )
    ledger.append_event(
        event_type="tool_result",
        payload={"result": "找到机票：东京羽田机场 HND，价格 3500 元"},
    )
    ledger.append_event(
        event_type="user",
        payload={"query": "再看看大阪关西机场的"},
    )
    ledger.append_event(
        event_type="tool_result",
        payload={"result": "找到机票：大阪关西机场 KIX，价格 3200 元"},
    )
    ledger.append_event(
        event_type="assistant",
        payload={"reply": "已经为您列出东京与大阪的往返航班对比。"},
    )

    # 检索“东京”
    results = search_raw_event_log(log_file=log_file, keyword="东京", limit=5)
    assert len(results) == 3

    # 验证倒序（最新出现的排在前面）
    seq_ids = [r["seq_id"] for r in results]
    assert seq_ids == [5, 2, 1]

    # 验证 limit 限制
    limit_1 = search_raw_event_log(log_file=log_file, keyword="东京", limit=1)
    assert len(limit_1) == 1
    assert limit_1[0]["seq_id"] == 5


def test_search_raw_event_log_regex_and_type_filter(tmp_path: Path):
    """验证正则表达式检索与按 event_type 过滤。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    ledger.append_event(
        event_type="user",
        payload={"query": "我的联系电话是 138-0000-1234"},
    )
    ledger.append_event(
        event_type="tool_result",
        payload={"result": "登记电话 139-8888-5678 成功"},
    )
    ledger.append_event(
        event_type="assistant",
        payload={"reply": "已确认您的手机号码。"},
    )

    # 正则搜索电话号码格式 \d{3}-\d{4}-\d{4}
    results = search_raw_event_log(
        log_file=log_file,
        keyword=r"\d{3}-\d{4}-\d{4}",
        regex=True,
    )
    assert len(results) == 2
    assert [r["seq_id"] for r in results] == [2, 1]

    # 带 event_type 过滤：只搜索 tool_result
    tool_only = search_raw_event_log(
        log_file=log_file,
        keyword=r"\d{3}-\d{4}-\d{4}",
        regex=True,
        event_type="tool_result",
    )
    assert len(tool_only) == 1
    assert tool_only[0]["seq_id"] == 2
    assert tool_only[0]["event_type"] == "tool_result"

    # 非法正则应抛出 ValueError 或 re.error
    with pytest.raises((ValueError, re.error)):
        search_raw_event_log(log_file=log_file, keyword="[unclosed_bracket", regex=True)


def test_concurrent_append_safety(tmp_path: Path):
    """验证多线程并发追加写入时，seq_id 严格连续递增无重复，且无行截断或损坏。"""
    log_file = tmp_path / "logs" / "main_session_events.jsonl"
    ledger = MainEventLedger(log_file=log_file)

    num_threads = 8
    events_per_thread = 25
    total_events = num_threads * events_per_thread

    def worker(worker_id: int):
        for i in range(events_per_thread):
            ledger.append_event(
                event_type="tool_result",
                payload={"worker_id": worker_id, "index": i},
            )

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert ledger.latest_seq_id == total_events

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == total_events

    seen_seq_ids = set()
    for line in lines:
        data = json.loads(line)
        sid = data["seq_id"]
        assert sid not in seen_seq_ids
        seen_seq_ids.add(sid)

    assert seen_seq_ids == set(range(1, total_events + 1))
