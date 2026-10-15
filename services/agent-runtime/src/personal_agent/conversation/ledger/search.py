import json
import re
from pathlib import Path
from typing import Any

from personal_agent.conversation.ledger.storage import reverse_read


def search_raw_event_log(
    log_file: str | Path,
    keyword: str,
    limit: int = 5,
    regex: bool = False,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    path = Path(log_file)
    if not path.exists():
        return []

    pattern = None
    if regex:
        try:
            pattern = re.compile(keyword)
        except re.error as e:
            raise ValueError(f"Invalid regex pattern: {keyword}. Error: {e}")
    results = []
    for line in reverse_read(path):
        if regex:
            if not pattern.search(line):
                continue
        else:
            if keyword not in line:
                continue
        result = json.loads(line)
        if event_type and result.get("event_type") != event_type:
            continue
        results.append(result)
        if len(results) >= limit:
            break
    return results
