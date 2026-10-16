"""personal_agent.conversation.pipeline —— 任务结束长程记忆提炼与做梦流水线。

在任务结束或后台调度时，一键自动串联 ColdMemoryExtractor 与 DreamEngine：
1. 消费 MainEventLedger 增量事件；
2. 经 create_llm_memory_extractor 提炼候选长程记忆并暂存至 MemoryInbox；
3. 触发 DreamEngine，由 create_llm_dream_consolidator 归并到 topics/*.md 并自动重建 INDEX.md。
"""

from pathlib import Path
from typing import Any

from personal_agent.conversation.dream import DreamEngine, DreamRequest
from personal_agent.conversation.dream.llm_consolidator import (
    create_llm_dream_consolidator,
)
from personal_agent.conversation.extractor import (
    ColdMemoryExtractor,
    ExtractorCursor,
    MemoryInbox,
)
from personal_agent.conversation.extractor.llm_extractor import (
    create_llm_memory_extractor,
)
from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.model.gateway import ModelGateway


def run_task_memory_pipeline(
    harness_dir: Path | str,
    model: ModelGateway,
    force_dream: bool = False,
) -> dict[str, Any]:
    """运行任务长程记忆提炼与做梦闭环流水线。"""
    h_dir = Path(harness_dir)
    memory_dir = h_dir / "memory"
    logs_dir = h_dir / "logs"
    memory_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    # 1. 组装提炼基础设施
    ledger = MainEventLedger(log_file=logs_dir / "main_session_events.jsonl")
    inbox = MemoryInbox(inbox_file=memory_dir / "inbox.jsonl")
    cursor = ExtractorCursor(cursor_file=memory_dir / "extractor_cursor.json")
    extract_fn = create_llm_memory_extractor(model)

    extractor = ColdMemoryExtractor(
        ledger=ledger,
        inbox=inbox,
        cursor=cursor,
        extract_fn=extract_fn,
    )

    # 2. 消费所有待提炼事件
    extraction_results = extractor.drain_all()
    extracted_items_count = sum(len(res.items) for res in extraction_results)

    # 3. 组装并触发做梦引擎
    consolidate_fn = create_llm_dream_consolidator(model)
    dream_engine = DreamEngine(
        memory_dir=memory_dir,
        inbox=inbox,
        consolidate_fn=consolidate_fn,
    )

    dream_res = dream_engine.run_dream(DreamRequest(force=force_dream))

    return {
        "extracted_items_count": extracted_items_count,
        "dream_executed": dream_res.success,
        "categories_updated": dream_res.categories_updated,
        "dream_result": dream_res,
    }
