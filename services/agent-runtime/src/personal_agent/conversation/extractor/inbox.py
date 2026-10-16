import threading
from pathlib import Path

from personal_agent.conversation.extractor.models import CandidateMemoryItem


class MemoryInbox:
    def __init__(self, inbox_file: str | Path | None = None):
        self.lock = threading.Lock()
        self.inbox_file = Path(inbox_file) if inbox_file else Path("inbox.jsonl")
        self.inbox_file.parent.mkdir(parents=True, exist_ok=True)
        self.inbox_file.touch(exist_ok=True)

    def append(self, item: CandidateMemoryItem):
        with self.lock, open(self.inbox_file, "a", encoding="utf-8") as f:
            f.write(item.model_dump_json() + "\n")

    def append_batch(self, items: list[CandidateMemoryItem]):
        with self.lock, open(self.inbox_file, "a", encoding="utf-8") as f:
            f.writelines(item.model_dump_json() + "\n" for item in items)

    def read_pending(self) -> list[CandidateMemoryItem]:
        items:list[CandidateMemoryItem] = []
        if not self.inbox_file.exists():
            return items
        with self.lock, open(self.inbox_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(CandidateMemoryItem.model_validate_json(line))
                except Exception:  # noqa: BLE001, S112
                    continue
        return items

    def count_pending(self) -> int:
        if not self.inbox_file.exists():
            return 0
        with self.lock, open(self.inbox_file, "r", encoding="utf-8") as f:
            return sum(1 for _ in f)
