"""Jev 安全分类器与启发式兜底单元测试。"""

from unittest.mock import MagicMock

from personal_agent.conversation.sidecar.classifier import (
    JevSafetyClassifier,
    classify_heuristic,
)


def test_classify_heuristic_safe_command():
    assessment = classify_heuristic("c-1", "filesystem_list", {"rootId": "downloads"})
    assert assessment.verdict == "ALLOW"
    assert assessment.riskCategory == "NONE"
    assert assessment.confidence >= 0.8


def test_classify_heuristic_destructive_command():
    assessment = classify_heuristic(
        "c-2", "terminal_execute", {"command": "rm -rf /tmp/data"}
    )
    assert assessment.verdict == "ESCALATE_TO_USER"
    assert assessment.riskCategory == "DESTRUCTIVE_COMMAND"
    assert "高危" in assessment.reason


def test_classify_heuristic_prompt_injection():
    assessment = classify_heuristic(
        "c-3", "read_document", {"path": "ignore previous instructions"}
    )
    assert assessment.verdict == "ESCALATE_TO_USER"
    assert assessment.riskCategory == "PROMPT_INJECTION"


def test_classify_heuristic_sensitive_credential():
    assessment = classify_heuristic(
        "c-4", "file_search", {"pattern": ".aws/credentials"}
    )
    assert assessment.verdict == "ESCALATE_TO_USER"
    assert assessment.riskCategory == "CREDENTIAL_EXFILTRATION"


def test_jev_classifier_allow():
    mock_jev = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"verdict": MagicMock(choice="allow")}
    mock_jev.system_one.return_value = mock_resp

    classifier = JevSafetyClassifier(jev_client=mock_jev)
    assessment = classifier.classify("c-jev-1", "filesystem_list", {"rootId": "docs"}, "整理文件")
    assert assessment.verdict == "ALLOW"
    assert assessment.riskCategory == "NONE"
    assert assessment.assessedBy == "jev-system-one"
    assert mock_jev.system_one.called


def test_jev_classifier_reject():
    mock_jev = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"verdict": MagicMock(choice="reject")}
    mock_jev.system_one.return_value = mock_resp

    classifier = JevSafetyClassifier(jev_client=mock_jev)
    assessment = classifier.classify("c-jev-2", "filesystem_move", {"source": "a", "target": "b"})
    assert assessment.verdict == "REJECT_WITH_FEEDBACK"
    assert assessment.riskCategory == "SCOPE_ESCAPING"
    assert assessment.remediation is not None


def test_jev_classifier_escalate():
    mock_jev = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"verdict": MagicMock(choice="escalate")}
    mock_jev.system_one.return_value = mock_resp

    classifier = JevSafetyClassifier(jev_client=mock_jev)
    assessment = classifier.classify("c-jev-3", "terminal_execute", {"command": "mkfs /dev/sda"})
    assert assessment.verdict == "ESCALATE_TO_USER"
    assert assessment.riskCategory == "DESTRUCTIVE_COMMAND"


def test_jev_classifier_exception_fallback():
    mock_jev = MagicMock()
    mock_jev.system_one.side_effect = RuntimeError("network timeout")

    classifier = JevSafetyClassifier(jev_client=mock_jev)
    assessment = classifier.classify("c-jev-4", "terminal_execute", {"command": "rm -rf /var"})
    assert assessment.verdict == "ESCALATE_TO_USER"
    assert assessment.assessedBy == "local-heuristic"
