import os
import re
from pathlib import Path

from _pytest.monkeypatch import MonkeyPatch

from personal_agent.tools.filesystem import list_pdfs, resolve_root

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _touch(path: Path, mtime: float, size: int) -> Path:
    """
    创建指定大小文件
    :param path:
    :param mtime:
    :param size:
    :return:创建的文件的路径
    """
    path.write_bytes(b"x" * size)
    os.utime(path, (mtime, mtime))
    return path


def test_list_pdfs_filters_and_sorts(tmp_path: Path):
    # 新 pdf、旧 pdf(大写扩展名)、非 pdf、子目录(内含 pdf，不应被递归到)
    _touch(tmp_path / "new.pdf", mtime=2_000_000.0, size=2048)
    _touch(tmp_path / "old.PDF", mtime=1_000_000.0, size=512)
    _touch(tmp_path / "note.txt", mtime=3_000_000.0, size=10)
    sub = tmp_path / "sub"
    sub.mkdir()
    _touch(sub / "nest.pdf", mtime=9_000_000.0, size=999)

    entries = list_pdfs(tmp_path)

    assert [e.name for e in entries] == ["new.pdf", "old.PDF"]
    assert entries[0].sizeBytes == 2048
    assert entries[1].sizeBytes == 512

    assert entries[0].absolutePath == (tmp_path / "new.pdf").resolve().as_posix()
    assert ISO_Z.match(entries[0].modifiedAt)
    assert isinstance(entries[0].sizeBytes, int) and entries[0].sizeBytes > 0

def test_list_pdfs_empty_dir(tmp_path: Path):
    assert list_pdfs(tmp_path) == []

def test_resolve_root_env_override(tmp_path: Path, monkeypatch: MonkeyPatch):
    monkeypatch.setenv("PERSONAL_AGENT_DOWNLOADS_DIR", str(tmp_path))
    assert resolve_root("downloads") == tmp_path


def test_resolve_root_default(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_DOWNLOADS_DIR", raising=False)
    assert resolve_root("downloads") == Path.home() / "Downloads"