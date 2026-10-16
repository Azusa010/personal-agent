import json
from pathlib import Path

from personal_agent.conversation.ledger.storage import reverse_read


class ExtractorCursor:
    def __init__(self, cursor_file: str | Path | None = None):
        self.last_extracted_seq_id = 0
        self.cursor_path = Path(cursor_file) if cursor_file else Path("inbox.jsonl")
        if self.cursor_path.exists():
            for line in reverse_read(self.cursor_path):
                line = line.strip()
                if not line:
                    continue
                raw = json.loads(line)
                if "last_extracted_seq_id" in raw:
                    self.last_extracted_seq_id = raw.get("last_extracted_seq_id", 0)
                    break
        else:
            self.last_extracted_seq_id = 0

    def advance(self, new_seq_id: int):
        self.last_extracted_seq_id = max(self.last_extracted_seq_id, new_seq_id)
        self.cursor_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.cursor_path, "a", encoding="utf-8") as f:
            import time

            f.write(
                json.dumps(
                    {
                        "last_extracted_seq_id": self.last_extracted_seq_id,
                        "updated_at": time.time(),
                    }
                )
                + "\n"
            )
