import os

from personal_agent.conversation.windows.models import EpochArchive, WindowConfig
from personal_agent.conversation.windows.sliding import SlidingWindowLedger


class TimeGateKeeper:
    def __init__(self, window: SlidingWindowLedger, config: WindowConfig | None = None):
        self.window = window
        self.config = config or WindowConfig(
            epochs_dir=os.path.join(window.ledger.log_file, "epochs")
        )
        self.last_interaction_timestamp = 0.0

    def record_interaction(self, timestamp: float):
        self.last_interaction_timestamp = timestamp

    def check_and_handle_timeout(
        self, current_timestamp: float | None = None
    ) -> EpochArchive | None:
        current_timestamp = current_timestamp or self.last_interaction_timestamp
        if (
            current_timestamp - self.last_interaction_timestamp
            > self.config.inactivity_threshold_seconds
        ):
            events, rolling_task_summary = (
                self.window.get_active_window().events,
                self.window.get_active_window().rolling_task_summary,
            )

            lines: list[str] = []
            lines.append(f"Epoch {self.window.ledger.current_epoch_id} Summary:")
            lines.append(rolling_task_summary)
            lines.append(f"Total events: {len(events)}")
            lines.append("Event details:")
            for event in events:
                lines.append(
                    f"Seq ID: {event.seq_id}, Type: {event.event_type}, Timestamp: {event.timestamp}, Token Count: {event.token_count}"
                )
            file_path = f"{self.config.epochs_dir}/epoch_{self.window.ledger.current_epoch_id}_summary.md"
            os.makedirs(self.config.epochs_dir, exist_ok=True)
            with open(file_path, "w") as f:
                f.write("\n".join(lines))

            elapsed_time = current_timestamp - self.last_interaction_timestamp
            old_epoch_id = self.window.ledger.current_epoch_id
            self.window.ledger.set_epoch_id(old_epoch_id + 1)
            boundary = self.window.find_safe_compaction_boundary(
                events, target_keep_turns=2
            )
            self.window.window_watermark = boundary

            summary = (
                f"[系统提示：距离上次交互已过去 {int(elapsed_time / 3600)} 小时，旧任务上下文"
                f"已归档至 epoch_{old_epoch_id}_summary.md。若用户延续旧话题请调用 "
                f'recall_epoch("epoch_{old_epoch_id}_summary.md")，若开启新话题请直接聚焦。]'
            ) + "\n".join(lines)

            self.window.rolling_task_summary = summary

            return EpochArchive(
                epoch_id=old_epoch_id,
                summary=summary,
                archived_at=str(current_timestamp),
                events_count=len(events),
                file_path=file_path,
                time_elapsed_seconds=current_timestamp
                - self.last_interaction_timestamp,
            )
        return None
