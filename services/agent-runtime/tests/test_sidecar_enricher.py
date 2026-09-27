"""test_sidecar_enricher.py —— Sidecar 上下文增强器与长输出压缩测试。

全面覆盖：
1. 记忆预选：Jev 评分分流（保留高分黄金事实，剔除低分噪音）
2. 记忆预选：Top-K 截断与阈值过滤
3. 记忆预选：无客户端或异常时的启发式相关度兜底
4. 长输出压缩：短文本无操作返回 (noop)
5. 长输出压缩：超长输出保存本地临时文件、Sidecar LLM 浓缩及携带 raw_output_path
6. 长输出压缩：无 LLM 客户端时的降级持久化与截断
"""

import json
from pathlib import Path
from unittest.mock import MagicMock

from personal_agent.conversation.model.gateway import Observation
from personal_agent.conversation.sidecar.enricher import (
    compact_and_persist_observation,
    filter_relevant_memories,
)
from personal_agent.protocol.models import SidecarCompactedObservation


def test_filter_relevant_memories_empty():
    """场景：候选记忆为空时直接返回空列表。"""
    assert filter_relevant_memories("任务目标", []) == []


def test_filter_relevant_memories_jev_scoring():
    """场景：利用 Jev 多维决策打分，高分约束和中分偏好保留，低分噪音被过滤。"""
    candidates = [
        {"id": "m-1", "content": "用户偏好使用 TypeScript 进行严格类型约束"},
        {"id": "m-2", "content": "用户上周在超市购买了牛奶与面包"},
        {"id": "m-3", "content": "用户写代码习惯使用 2 个空格缩进"},
    ]

    mock_client = MagicMock()
    mock_resp = MagicMock()
    # m-1: 约束 (96.5分)
    r0, i0, c0 = MagicMock(), MagicMock(), MagicMock()
    r0.noul, i0.score, c0.choice = 0.95, 3.8, "constraint"
    # m-2: 噪音 (0分)
    r1, i1, c1 = MagicMock(), MagicMock(), MagicMock()
    r1.noul, i1.score, c1.choice = 0.02, 0.05, "noise"
    # m-3: 风格偏好 (51.5分)
    r2, i2, c2 = MagicMock(), MagicMock(), MagicMock()
    r2.noul, i2.score, c2.choice = 0.65, 1.8, "preference"

    mock_resp.answers = {
        "rel_0": r0, "imp_0": i0, "role_0": c0,
        "rel_1": r1, "imp_1": i1, "role_1": c1,
        "rel_2": r2, "imp_2": i2, "role_2": c2,
    }
    mock_client.system_one.return_value = mock_resp

    filtered = filter_relevant_memories(
        goal="重构前端组件并补充单元测试",
        candidates=candidates,
        threshold=45.0,
        top_k=3,
        client=mock_client,
    )

    # 应该保留 m-1 (约束 ~96.5分) 与 m-3 (偏好 ~51.5分)，过滤掉 m-2 (噪音 0分)
    assert len(filtered) == 2
    assert filtered[0]["id"] == "m-1"
    assert filtered[1]["id"] == "m-3"


def test_filter_relevant_memories_top_k_limiting():
    """场景：多条候选记忆均满足阈值，严格按得分降序截取前 top_k 条。"""
    candidates = [
        {"id": f"m-{i}", "content": f"关键事实 {i}"} for i in range(4)
    ]

    mock_client = MagicMock()
    mock_resp = MagicMock()
    # 模拟分数梯队：m-0(偏好 51分), m-1(低分噪音 0分), m-2(高分约束 98分), m-3(背景 75分)
    configs = [
        (0.6, 1.8, "preference"),  # ~51.5分
        (0.01, 0.0, "noise"),       # 0分
        (0.98, 3.9, "constraint"),  # ~98.3分
        (0.85, 3.4, "context"),     # ~74.5分
    ]
    mock_resp.answers = {}
    for i, (noul, score, role) in enumerate(configs):
        r, s, c = MagicMock(), MagicMock(), MagicMock()
        r.noul, s.score, c.choice = noul, score, role
        mock_resp.answers[f"rel_{i}"] = r
        mock_resp.answers[f"imp_{i}"] = s
        mock_resp.answers[f"role_{i}"] = c

    mock_client.system_one.return_value = mock_resp

    filtered = filter_relevant_memories(
        goal="任务执行",
        candidates=candidates,
        threshold=45.0,
        top_k=2,
        client=mock_client,
    )

    assert len(filtered) == 2
    # 前两条应为得分最高的 m-2 (98分) 与 m-3 (75分)
    assert filtered[0]["id"] == "m-2"
    assert filtered[1]["id"] == "m-3"


def test_filter_relevant_memories_heuristic_fallback():
    """场景：Jev 客户端不可用，触发本地词项重合度启发式打分。"""
    candidates = [
        {"id": "m-rel", "content": "用户强烈要求使用 TypeScript 和 Python 双语言标准"},
        {"id": "m-irrel", "content": "今天天气晴朗适合户外散步"},
    ]

    # client 为 None 触发 fallback
    filtered = filter_relevant_memories(
        goal="请用 Python 编写数据分析脚本",
        candidates=candidates,
        threshold=30.0,
        top_k=2,
        client=None,
    )

    assert len(filtered) == 1
    assert filtered[0]["id"] == "m-rel"


def test_compact_and_persist_short_observation_noop(tmp_path: Path):
    """场景：工具输出未超门槛（<=1200 字符），原样返回且不写入临时文件。"""
    obs = Observation(
        callId="c-short",
        capability="filesystem_list",
        ok=True,
        payload={"entries": ["a.txt", "b.txt"]},
        arguments={"path": "."},
    )

    result_obs, raw_file = compact_and_persist_observation(
        observation=obs,
        max_chars=1200,
        temp_dir=tmp_path,
    )

    assert result_obs == obs
    assert raw_file is None
    assert list(tmp_path.glob("*.txt")) == []


def test_compact_and_persist_long_observation_persists_raw_and_compacts(tmp_path: Path):
    """场景：工具输出超长（>1200 字符），原始数据写入临时文件并由 Sidecar LLM 动态浓缩。"""
    big_data = "LINE_DATA_" + "X" * 1500
    obs = Observation(
        callId="call-huge-1",
        capability="terminal_execute",
        ok=True,
        payload={"stdout": big_data, "exitCode": 0},
        arguments={"command": "cat huge.log"},
    )

    mock_llm = MagicMock()
    mock_llm.compact_observation.return_value = SidecarCompactedObservation(
        callId="call-huge-1",
        capability="terminal_execute",
        originalChars=len(json.dumps(obs.payload, ensure_ascii=False)),
        compactedChars=120,
        summary="日志包含大量长文本数据，执行状态正常",
        keyFacts=["退出码为 0", "包含大量连续特征字符"],
    )

    compacted_obs, raw_file = compact_and_persist_observation(
        observation=obs,
        sidecar_llm=mock_llm,
        max_chars=1200,
        temp_dir=tmp_path,
    )

    assert raw_file is not None
    assert raw_file.exists()
    assert raw_file.name == "call_call-huge-1_raw.txt"

    # 验证磁盘上的原始数据内容完整无损
    raw_saved = raw_file.read_text(encoding="utf-8")
    assert big_data in raw_saved

    # 验证返回给当前上下文的 Observation 结构
    assert compacted_obs.callId == "call-huge-1"
    assert compacted_obs.capability == "terminal_execute"
    assert compacted_obs.ok is True
    assert compacted_obs.payload["compacted"] is True
    assert compacted_obs.payload["summary"] == "日志包含大量长文本数据，执行状态正常"
    assert compacted_obs.payload["keyFacts"] == ["退出码为 0", "包含大量连续特征字符"]
    assert compacted_obs.payload["raw_output_path"] == str(raw_file)
    assert str(raw_file) in compacted_obs.payload["hint"]
    assert "可按需读取" in compacted_obs.payload["hint"] or "查阅细节" in compacted_obs.payload["hint"]


def test_compact_and_persist_fallback_when_no_llm(tmp_path: Path):
    """场景：超长输出但在无 LLM 客户端时，仍安全落盘并生成确定性截断摘要。"""
    long_text = "ERR_LOG_" * 300
    obs = Observation(
        callId="call-fallback-2",
        capability="document_extract_pdf",
        ok=False,
        payload={"error": long_text},
        arguments={"path": "corrupt.pdf"},
    )

    compacted_obs, raw_file = compact_and_persist_observation(
        observation=obs,
        sidecar_llm=None,
        max_chars=500,
        temp_dir=tmp_path,
    )

    assert raw_file is not None
    assert raw_file.exists()
    assert compacted_obs.ok is False
    assert compacted_obs.payload["compacted"] is True
    assert compacted_obs.payload["raw_output_path"] == str(raw_file)
    assert "内容过长已截断" in compacted_obs.payload["summary"]
