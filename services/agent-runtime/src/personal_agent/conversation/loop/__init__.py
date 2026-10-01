"""conversation.loop —— 对话 Agent 驱动引擎与执行策略。"""

from personal_agent.conversation.loop.engine import AgentEngine
from personal_agent.conversation.loop.fault_classifier import (
    FAULT_CLASSIFICATION,
    FAULT_LAYER_MAP,
    FaultClassification,
    FaultLayer,
    RetryVerdict,
    StreamStalledError,
    StreamWatchdog,
    classify_fault,
)
from personal_agent.conversation.loop.react_loop import ReActLoop, ReActOutcome
from personal_agent.conversation.loop.recovery import (
    DEFAULT_BREAKER_THRESHOLDS,
    RecoveryLevel,
    RecoveryPathBreaker,
    RecoveryPlan,
    compute_backoff_delay,
    determine_recovery_plan,
)
from personal_agent.conversation.loop.strategy import (
    AgentStrategy,
    ClassicStrategy,
    PlanAndExecuteStrategy,
    ReActStrategy,
    _settle_usage,
)
from personal_agent.conversation.loop.trajectory import (
    DeathSpiralError,
    DeathSpiralProtector,
    ToolFingerprintDetector,
    TrajectoryRepairReport,
    compute_tool_fingerprint,
    repair_trajectory_integrity,
)

__all__ = [
    "DEFAULT_BREAKER_THRESHOLDS",
    "FAULT_CLASSIFICATION",
    "FAULT_LAYER_MAP",
    "AgentEngine",
    "AgentStrategy",
    "ClassicStrategy",
    "DeathSpiralError",
    "DeathSpiralProtector",
    "FaultClassification",
    "FaultLayer",
    "PlanAndExecuteStrategy",
    "ReActLoop",
    "ReActOutcome",
    "ReActStrategy",
    "RecoveryLevel",
    "RecoveryPathBreaker",
    "RecoveryPlan",
    "RetryVerdict",
    "StreamStalledError",
    "StreamWatchdog",
    "ToolFingerprintDetector",
    "TrajectoryRepairReport",
    "_settle_usage",
    "classify_fault",
    "compute_backoff_delay",
    "compute_tool_fingerprint",
    "determine_recovery_plan",
    "repair_trajectory_integrity",
]