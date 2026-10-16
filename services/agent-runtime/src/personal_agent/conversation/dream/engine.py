import os
import threading
from collections.abc import Callable
from pathlib import Path

from personal_agent.conversation.dream.indexer import IndexCompiler
from personal_agent.conversation.dream.lock import AtomicRenameLock
from personal_agent.conversation.dream.models import DreamRequest, DreamResult
from personal_agent.conversation.extractor import CandidateMemoryItem, MemoryInbox


class DreamEngine:
    def __init__(
        self,
        memory_dir: str | Path,
        inbox: MemoryInbox | None = None,
        consolidate_fn: Callable[[str, str, list[CandidateMemoryItem]], str]
        | None = None,
        default_min_items: int = 5,
    ):
        self.memory_dir = Path(memory_dir)
        self.inbox = inbox if inbox else MemoryInbox(self.memory_dir / "inbox.jsonl")
        self.consolidate_fn = consolidate_fn if consolidate_fn else None
        self.default_min_items = default_min_items
        self.lock = threading.Lock()
        self.atom_lock = AtomicRenameLock(
            inbox_file=self.inbox.inbox_file,
            lock_file=self.memory_dir / "inbox.lock.jsonl",
        )
        self.indexer = IndexCompiler(self.memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        (self.memory_dir / "topics").mkdir(parents=True, exist_ok=True)

    def run_dream(self, request: DreamRequest | None = None) -> DreamResult:
        with self.lock:
            req = request or DreamRequest(
                force=False, min_pending_items=self.default_min_items
            )
            if not req.force and self.inbox.count_pending() < req.min_pending_items:
                return DreamResult(
                    success=False,
                    consolidated_items_count=0,
                    categories_updated=[],
                    index_rebuilt=False,
                    message=f"Not enough pending items to process. Current count: {self.inbox.count_pending()}",
                )
            atom_lock_acquired = self.atom_lock.try_acquire()
            if not atom_lock_acquired:
                return DreamResult(
                    success=False,
                    consolidated_items_count=0,
                    categories_updated=[],
                    index_rebuilt=False,
                    message="Could not acquire lock for processing. Another process may be running.",
                )
            with open(self.atom_lock.lock_file, "r", encoding="utf-8") as f:
                pending_items = [
                    CandidateMemoryItem.model_validate_json(line)
                    for line in f
                    if line.strip()
                ]
            inbox_items = {
                item.category: [] for item in pending_items if item.category is not None
            }
            inbox_items["other"] = []
            for i in pending_items:
                if i.category not in inbox_items:
                    inbox_items["other"].append(i)
                elif i.category is not None:
                    inbox_items[i.category].append(i)

            for c, values in inbox_items.items():
                if not values:
                    continue
                category_path = self.memory_dir / "topics" / f"{c}.md"
                category_tmp_path = self.memory_dir / "topics" / f"{c}.md.tmp"
                if category_path.exists():
                    with open(category_path, "r", encoding="utf-8") as f:
                        existing_content = f.read()
                else:
                    existing_content = ""
                if self.consolidate_fn is not None:
                    new_content = self.consolidate_fn(c, existing_content, values)
                else:
                    new_content = (
                        existing_content
                        + "\n"
                        + "\n".join(["- " + i.content for i in values])
                    )
                with open(category_tmp_path, "w", encoding="utf-8") as f:
                    f.write(new_content)
                    os.fsync(f.fileno())
                os.replace(
                    category_tmp_path,
                    category_path,
                )
            self.indexer.recompile()
            self.atom_lock.release()
            return DreamResult(
                success=True,
                consolidated_items_count=len(pending_items),
                categories_updated= [c for c,vals in inbox_items.items() if vals],
                index_rebuilt=True,
                message="Dream processing completed successfully.",
                lock_file_path=str(self.atom_lock.lock_file),
            )
