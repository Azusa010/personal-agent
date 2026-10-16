from pathlib import Path

from personal_agent.conversation.topics import TopicSwitchResult
from personal_agent.conversation.windows import SlidingWindowLedger


class TopicSwitchHandler:
    def __init__(
        self, window: SlidingWindowLedger, epochs_dir: str | Path | None = None
    ):
        self.window = window
        self.epochs_dir = epochs_dir

    def archive_current_topic_and_switch(
        self,
        old_topic_summary: str,
        new_topic_intent: str,
        switch_user_seq_id: int | None = None,
    ) -> TopicSwitchResult:
        epoch_dir = Path(self.epochs_dir) if self.epochs_dir else Path("epochs")
        epoch_dir.mkdir(parents=True, exist_ok=True)
        old_epoch_id = self.window.ledger.current_epoch_id
        epoch_path = epoch_dir / f"epoch_{old_epoch_id}_summary.md"
        with open(epoch_path, "w",encoding="utf-8") as f:
            f.write(f"# Epoch {old_epoch_id} Summary\n\n")
            f.write(old_topic_summary)

        self.window.ledger.set_epoch_id(old_epoch_id + 1)

        if switch_user_seq_id is not None:
            self.window.window_watermark = max(0,switch_user_seq_id - 1)
        else:
            self.window.window_watermark = max(0,self.window.ledger.latest_seq_id - 1)

        self.window.rolling_task_summary = f"[新话题:{new_topic_intent}]"
        return TopicSwitchResult(
            success=True,
            archived_epoch_id=old_epoch_id,
            archived_file_path=str(epoch_path),
            new_topic_intent=new_topic_intent,
            message=f"Switched to new topic: {new_topic_intent}",
        )
