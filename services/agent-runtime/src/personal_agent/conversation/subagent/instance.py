from typing import Any

from personal_agent.conversation.subagent.isolator import TraceIsolator
from personal_agent.conversation.subagent.models import (
    SubagentConfig,
    SubagentResult,
    SubagentStatus,
)


class SubagentInstance:
    def __init__(
        self,
        run_id: str,
        role: str,
        goal: str,
        system_prompt: str,
        tools: list[dict[str, Any]] | None = None,
        isolator: TraceIsolator | None = None,
        status: SubagentStatus = "pending",
        config: SubagentConfig | None = None,
        created_at: str | None = None,
        started_at: str | None = None,
        finished_at: str | None = None,
    ):
        self.run_id = run_id
        self.role = role
        self.goal = goal
        self.system_prompt = system_prompt
        self.tools = tools or []
        self.isolator = isolator or TraceIsolator(run_id, f"traces/{run_id}.jsonl")
        self.status = status
        self.config = config or SubagentConfig(
            role=role, goal=goal, specific_instructions=None, allowed_tools=tools
        )
        self.created_at = created_at
        self.started_at = started_at
        self.finished_at = finished_at

    def start(self):
        if self.status != "pending":
            raise ValueError(f"Cannot start subagent in status {self.status}")
        self.status = "running"
        self.isolator.append_event("lifecycle", {"event": "start"})

    def record_step(
        self,
        thought: str | None = None,
        tool_call: dict[str, Any] | None = None,
        tool_result: dict[str, Any] | None = None,
    ):
        if self.status != "running":
            raise ValueError(f"Cannot record step for subagent in status {self.status}")
        if thought:
            self.isolator.record_thought(thought)
        if tool_call:
            self.isolator.record_tool_call(
                tool_call.get("call_id", ""),
                tool_call.get("tool_name", ""),
                tool_call.get("arguments", {}),
            )
        if tool_result:
            self.isolator.record_tool_result(
                tool_result.get("call_id", ""),
                tool_result.get("tool_name", ""),
                tool_result.get("result", {}),
            )

    def complete(
        self, summary: str, output: Any = None, artifacts: list[str] | None = None
    ) -> SubagentResult:
        if self.status != "running":
            raise ValueError(f"Cannot complete subagent in status {self.status}")
        self.status = "completed"
        self.isolator.append_event("lifecycle", {"event": "complete"})
        total_steps = self.isolator.get_total_steps()
        return SubagentResult(
            run_id=self.run_id,
            role=self.role,
            status=self.status,
            summary=summary,
            output=output,
            trace_file=str(self.isolator.trace_file),
            total_steps=total_steps,
            artifacts=artifacts or [],
        )

    def fail(self, error: str) -> SubagentResult:
        if self.status not in ["running", "pending"]:
            raise ValueError(f"Cannot fail subagent in status {self.status}")
        self.status = "failed"
        self.isolator.append_event("lifecycle", {"event": "fail"})
        total_steps = self.isolator.get_total_steps()
        return SubagentResult(
            run_id=self.run_id,
            role=self.role,
            status=self.status,
            summary="Subagent failed",
            output=None,
            trace_file=str(self.isolator.trace_file),
            total_steps=total_steps,
            artifacts=[],
            error=error,
        )

    def cancel(self, reason: str = "Cancelled by supervisor") -> SubagentResult:
        if self.status not in ["running", "pending"]:
            raise ValueError(f"Cannot cancel subagent in status {self.status}")
        self.status = "cancelled"
        self.isolator.append_event("lifecycle", {"event": "cancel"})
        total_steps = self.isolator.get_total_steps()
        return SubagentResult(
            run_id=self.run_id,
            role=self.role,
            status=self.status,
            summary="Subagent cancelled",
            output=None,
            trace_file=self.isolator.trace_file,
            total_steps=total_steps,
            artifacts=[],
            error=reason,
        )
