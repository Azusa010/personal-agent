"""StreamBarrier 并发流式屏障单元测试。"""

from unittest.mock import MagicMock

from personal_agent.conversation.sidecar.barrier import StreamBarrier
from personal_agent.protocol.models import SidecarAssessment
from personal_agent.shared import now_occurred_at


def test_barrier_submit_and_wait():
    mock_classifier = MagicMock()
    mock_classifier.classify.return_value = SidecarAssessment(
        callId="c-b1",
        capability="filesystem_list",
        verdict="ALLOW",
        riskCategory="NONE",
        confidence=1.0,
        reason="安全",
        assessedBy="mock",
        occurredAt=now_occurred_at(),
    )

    barrier = StreamBarrier(classifier=mock_classifier)
    try:
        barrier.submit("c-b1", "filesystem_list", {"rootId": "downloads"})
        res = barrier.wait_or_pass("c-b1", "filesystem_list", {"rootId": "downloads"})
        assert res.verdict == "ALLOW"
        assert res.callId == "c-b1"
    finally:
        barrier.close()


def test_barrier_direct_wait_without_submit():
    mock_classifier = MagicMock()
    mock_classifier.classify.return_value = SidecarAssessment(
        callId="c-b2",
        capability="filesystem_list",
        verdict="ALLOW",
        riskCategory="NONE",
        confidence=1.0,
        reason="直接调用安全",
        assessedBy="mock",
        occurredAt=now_occurred_at(),
    )

    barrier = StreamBarrier(classifier=mock_classifier)
    try:
        res = barrier.wait_or_pass("c-b2", "filesystem_list", {"rootId": "downloads"})
        assert res.verdict == "ALLOW"
        assert mock_classifier.classify.called
    finally:
        barrier.close()
