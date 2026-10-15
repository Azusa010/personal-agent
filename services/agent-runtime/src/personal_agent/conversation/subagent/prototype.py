import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from personal_agent.conversation.subagent.instance import SubagentInstance
from personal_agent.conversation.subagent.isolator import TraceIsolator


class SubagentPrototype:
    def __init__(
        self,
        system_prompt: str,
        base_tools: list[dict[str, Any]] | None = None,
        model: str = "deepseek-flash",
        max_steps: int = 100,
        default_traces_dir: str | Path | None = None,
    ):
        self.system_prompt = system_prompt
        self.base_tools = base_tools or []
        self.model = model
        self.max_steps = max_steps
        self.default_traces_dir = default_traces_dir or Path("traces")

    def fork(
        self,
        role: str,
        goal: str,
        run_id: str | None = None,
        specific_instructions: str | None = None,
        allowed_tools: list[str] | None = None,
        traces_dir: str | Path | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SubagentInstance:
        run_id = f"subagent-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
        trace_file = self.default_traces_dir if traces_dir is None else traces_dir
        trace_file = trace_file / f"{run_id}.jsonl"
        return SubagentInstance(
            run_id=run_id,
            role=role,
            goal=goal,
            system_prompt=self.system_prompt + role + goal + (specific_instructions or ""),
            tools= [tool for tool in self.base_tools if not allowed_tools or tool["name"] in allowed_tools],
            isolator=TraceIsolator(run_id, trace_file),
            status="pending",
            config=None,
            created_at=None,
            started_at=None,
            finished_at=None,
        )
