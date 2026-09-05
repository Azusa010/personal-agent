import os
from datetime import UTC, datetime
from pathlib import Path

from personal_agent.protocol.models import PdfEntry

_ROOT_ENV = {"downloads": "PERSONAL_AGENT_DOWNLOADS_DIR"}


def resolve_root(root_id) -> Path:
    """把白名单的root_id解析成目录"""
    if root_id not in _ROOT_ENV:
        raise KeyError(root_id)
    env_val = os.environ.get(_ROOT_ENV[root_id])
    if env_val:
        return Path(env_val)
    return Path.home() / "Downloads"


def _format_iso(mtime: float):
    """格式化 时间戳"""
    return (
        datetime.fromtimestamp(mtime, tz=UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def list_pdfs(base: Path) -> list[PdfEntry]:
    """列出 base 下的pdfs，过滤 .pdf"""
    scored: list[tuple[float, PdfEntry]] = []
    for child in base.iterdir():
        try:
            if not child.is_file():
                continue
            if child.suffix.lower() != ".pdf":
                continue
            stat = child.stat()
        except OSError:
            continue
        mtime = stat.st_mtime
        scored.append(
            (
                mtime,
                PdfEntry(
                    name=child.name,
                    absolutePath=child.resolve().as_posix(),
                    modifiedAt=_format_iso(mtime),
                    sizeBytes=stat.st_size,
                ),
            )
        )
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [entry for _, entry in scored]
