from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

SubagentStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


class SubagentTraceEvent(BaseModel):
    step_id: int
    timestamp: str
    event_type: str
    payload: dict[str, Any]


class SubagentConfig(BaseModel):
    role: str
    goal: str
    specific_instructions: str | None = None
    allowed_tools: list[dict[str,Any]] | None = None
    metadata: dict[str, Any] | None = Field(default_factory=dict)


class SubagentResult(BaseModel):
    run_id: str
    role: str
    status: SubagentStatus
    summary: str
    output: Any = None
    trace_file: str | Path
    total_steps: int = 0
    artifacts: list[str] = Field(default_factory=list)
    error: str | None = None
    duration_ms: int = 0

class SpawnSubagentParams(BaseModel):
    role: str
    goal: str
    prototype: str = "general"
    specific_instructions: str | None = None
    allowed_tools: list[str] | None = None
