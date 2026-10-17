from collections.abc import Callable
from typing import Any

from personal_agent.conversation import ModelContext, ModelGateway, ToolCallDecision
from personal_agent.conversation.model import StepCompleteDecision, SummaryDecision
from personal_agent.conversation.subagent import SubagentPool, SubagentResult


class SubagentRunner:
    def __init__(
        self,
        pool: SubagentPool,
        model: ModelGateway,
        tool_executor: Callable[[str, dict[str, Any]], Any] | None = None,
    ):
        self.pool = pool
        self.model = model
        self.tool_executor = tool_executor

    def run(
        self,
        role: str,
        goal: str,
        prototype: str = "general",
        specific_instructions: str | None = None,
        allowed_tools: list[str] | None = None,
        max_steps: int = 15,
    ) -> SubagentResult:
        instance = self.pool.spawn(
            role=role,
            goal=goal,
            prototype=prototype,
            specific_instructions=specific_instructions,
        )
        instance.start()
        step = 0
        result: SubagentResult | None = None
        try:
            while step < max_steps:
                context = ModelContext(
                    taskGoal=goal,
                    visibleCapabilities=allowed_tools or [],
                    profile=None,
                    systemPrompt=instance.system_prompt,
                )

                step += 1
                decision = self.model.decide(context=context)
                if isinstance(decision, ToolCallDecision):  # noqa: SIM102
                    if self.tool_executor and (
                        allowed_tools is None or decision.capability in allowed_tools
                    ):
                        tool_result = self.tool_executor(
                            decision.capability, decision.arguments
                        )
                        instance.record_step(
                            thought=getattr(decision, "thinking", None)
                            or getattr(decision, "thought", None),
                            tool_call=decision.model_dump(),
                            tool_result=tool_result,
                        )

                if isinstance(decision, (SummaryDecision, StepCompleteDecision)):
                    result = instance.complete(
                        summary=decision.reply
                        if isinstance(decision, SummaryDecision)
                        else decision.result,
                        output=decision.model_dump(),
                    )
                    break

        except Exception as e:  # noqa: BLE001
            result = instance.fail(error=str(e))
        finally:
            if result is None:
                final_context = ModelContext(
                    taskGoal=goal,
                    visibleCapabilities=[],
                    profile=None,
                    systemPrompt=instance.system_prompt
                    + "\n\n你已达到本次执行的步数预算上限，请综合上述所有步骤探查到的线索与事实，给出最终的结论总结，不再调用任何工具",
                )
                final_decision = self.model.decide(context=final_context)
                if isinstance(final_decision, SummaryDecision):
                    reply = final_decision.reply
                elif isinstance(final_decision, StepCompleteDecision):
                    reply = final_decision.result
                elif isinstance(final_decision, ToolCallDecision) and final_decision.thinking:
                    reply = f"Subagent reached step limit: {final_decision.thinking}"
                else:
                    reply = "Subagent reached step limit without a summary."

                result = instance.complete(
                    summary=reply,
                    output=final_decision.model_dump()
                    if final_decision is not None
                    else None,
                )
            if result:
                self.pool.finalize(instance.run_id, result)
        return result
