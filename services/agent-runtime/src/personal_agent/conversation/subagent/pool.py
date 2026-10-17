from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.subagent.backfeed import backfeed_to_main_ledger
from personal_agent.conversation.subagent.instance import SubagentInstance
from personal_agent.conversation.subagent.models import SubagentResult
from personal_agent.conversation.subagent.prototype import SubagentPrototype


class SubagentPool:
    def __init__(
        self,
        prototype: SubagentPrototype | None = None,
        ledger: MainEventLedger | None = None,
        prototypes: dict[str, SubagentPrototype] | None = None,
    ):
        self.active: dict[str, SubagentInstance] = {}
        self.ledger = ledger
        self.instances: dict[str, SubagentInstance] = {}
        self.prototypes = prototypes
        if prototype and prototypes is None:
            self.prototypes = {"general": prototype}
        self.default_prototype = (
            prototype
            or self.prototypes.get("general")
            or self.prototypes.values().__iter__().__next__()
        )
        self.prototype = self.default_prototype

    def spawn(
        self, role: str, goal: str, prototype: str = "general", **kwargs
    ) -> SubagentInstance:
        target_proto = self.prototypes.get(prototype) or self.default_prototype
        instance = target_proto.fork(role, goal, **kwargs)
        instance.role = role
        instance.goal = goal
        self.active[instance.run_id] = instance
        self.instances[instance.run_id] = instance
        return instance

    def get(self, run_id: str) -> SubagentInstance | None:
        return self.instances.get(run_id, None)

    def list_active(self) -> list[SubagentInstance]:
        return list(self.active.values())

    def list_all(self) -> list[SubagentInstance]:
        return list(self.instances.values())

    def finalize(self, run_id: str, result: SubagentResult) -> LedgerEvent | None:
        instance = self.active.pop(run_id, None)
        if not instance:
            return None
        if self.ledger:
            event = backfeed_to_main_ledger(self.ledger, result)
            return event
        return None
