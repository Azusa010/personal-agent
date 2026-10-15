from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.subagent.models import SubagentResult


def backfeed_to_main_ledger(
    ledger: MainEventLedger, result: SubagentResult
) -> LedgerEvent:
    payload = {
        "subagent_run_id": result.run_id,
        "role": result.role,
        "status": result.status,
        "summary": result.summary,
        "output": result.output,
        "trace_file": result.trace_file,
        "artifacts": result.artifacts,
        "total_steps": result.total_steps,
        "duration_ms": result.duration_ms,
        "error": result.error,
    }
    event = ledger.append_event(event_type="subagent", payload=payload)
    return event
