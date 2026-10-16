import os
from pathlib import Path


class AtomicRenameLock:
    def __init__(self, inbox_file: str | Path, lock_file: str | Path | None = None):
        self.inbox_file = Path(inbox_file)
        self.lock_file = (
            Path(lock_file)
            if lock_file
            else self.inbox_file.with_name(f"{self.inbox_file.stem}.lock{self.inbox_file.suffix}")
        )
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)

    def is_locked(self) -> bool:
        return self.lock_file.exists()

    def try_acquire(self) -> bool:
        if self.is_locked():
            return False
        if not self.inbox_file.exists() or self.inbox_file.stat().st_size == 0:
            return False
        try:
            os.replace(self.inbox_file, self.lock_file)
            return True
        except Exception:  # noqa: BLE001
            return False

    def release(self, archive_path: str | Path | None = None):
        if archive_path is None:
            self.lock_file.unlink(missing_ok=True)
            return
        if archive_path:
            archive_path = Path(archive_path)
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(self.lock_file, archive_path)
            self.lock_file.unlink(missing_ok=True)
            return