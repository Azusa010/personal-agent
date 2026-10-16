from pathlib import Path

from personal_agent.conversation.ledger import (
    LedgerEvent,
    MainEventLedger,
    search_raw_event_log,
)


class ThreeTierRetriever:
    def __init__(self, memory_dir: str | Path, ledger: MainEventLedger | None = None):
        self.memory_dir = Path(memory_dir)
        self.ledger = ledger if ledger else MainEventLedger(log_file="event_log.jsonl")

    def get_system_index(self) -> str:
        index_path = Path(self.memory_dir) / "INDEX.md"
        if index_path.exists():
            return index_path.read_text(encoding="utf-8")
        else:
            return ""

    def read_memory_topic(self, topic_name: str) -> str:
        filename = topic_name if topic_name.endswith(".md") else f"{topic_name}.md"
        memory_path = Path(self.memory_dir) / "topics" / filename
        if memory_path.exists():
            return memory_path.read_text(encoding="utf-8")
        else:
            raise FileNotFoundError(
                f"Memory topic file not found: {memory_path},exists_files={[p.name for p in memory_path.parents[0].glob('*.md')]}"
            )

    def search_raw_events(self, query: str, limit: int = 5) -> list[LedgerEvent]:
        raw = search_raw_event_log(
            log_file=self.ledger.log_file,
            keyword=query,
            limit=limit,
        )
        return [LedgerEvent(**event) for event in raw]
