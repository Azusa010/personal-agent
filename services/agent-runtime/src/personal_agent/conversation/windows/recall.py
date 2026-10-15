from pathlib import Path


def recall_epoch(archive_file: str | Path, epochs_dir: str | Path | None = None) -> str:
    base_dir = Path(epochs_dir) if epochs_dir else Path("./epochs")
    clean_name = Path(archive_file).name
    if not clean_name.endswith(".md"):
        clean_name += ".md"
    target_path = base_dir / clean_name
    if not target_path.exists():
        available = sorted([p.name for p  in base_dir.glob("epoch_*.md")])
        raise FileNotFoundError(
            f"Epoch archive '{clean_name}' not found in {base_dir}. Available archives: {available}"
        )

    content = target_path.read_text(encoding="utf-8").strip()
    return content