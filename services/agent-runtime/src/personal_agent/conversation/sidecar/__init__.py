"""Sidecar 旁路子系统 (PersonalAgent Sidecar Subsystem)

包含：
- Jev 极速安全分类器 (classifier.py)
- 轻量级 Sidecar LLM 辅助客户端 (llm_client.py)
- 并发流式审查屏障 (barrier.py)
- 拒绝熔断器状态机 (circuit_breaker.py)
"""

from personal_agent.conversation.sidecar.barrier import StreamBarrier
from personal_agent.conversation.sidecar.circuit_breaker import (
    DEFAULT_CONSECUTIVE_REJECTION_THRESHOLD,
    RejectionCircuitBreaker,
)
from personal_agent.conversation.sidecar.classifier import (
    JevSafetyClassifier,
    classify_heuristic,
)
from personal_agent.conversation.sidecar.llm_client import SidecarLlmClient

__all__ = [
    "DEFAULT_CONSECUTIVE_REJECTION_THRESHOLD",
    "JevSafetyClassifier",
    "RejectionCircuitBreaker",
    "SidecarLlmClient",
    "StreamBarrier",
    "classify_heuristic",
]
