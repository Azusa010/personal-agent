import os
from pathlib import Path


class IndexCompiler:
    def __init__(self, memory_dir: str | Path):
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.topic_dir = self.memory_dir / "topics"
        self.index_file = self.memory_dir / "INDEX.md"

    def recompile(self) -> str:
        self.topic_dir.mkdir(parents=True, exist_ok=True)
        lines = ["# 长期记忆索引库 (Memory Index)"]
        for file in sorted(self.topic_dir.glob("*.md")):
            content = ""
            with open(file, "r", encoding="utf-8") as f:
                content = f.readline().strip()
                if not content:
                    content = f.read()[:80].strip()
            lines.append(f"- [{file.name}]: {content}")
        with open(self.memory_dir / "INDEX.md.tmp", "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
            os.fsync(f.fileno())
        os.replace(self.memory_dir / "INDEX.md.tmp", self.index_file)
        return "\n".join(lines)
