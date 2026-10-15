import json
from pathlib import Path

from uuid6 import uuid7

from personal_agent.conversation.ledger.models import BlobPointer


class LedgerGuard:
    def __init__(
        self,
        blob_dir: str | Path,
        preview_chars: int,
        max_chars: int = 12000,
        max_lines: int = 200,
        max_line_len: int = 500,
    ):
        self.blob_dir = blob_dir
        self.max_chars = max_chars
        self.max_lines = max_lines
        self.preview_chars = preview_chars
        self.max_line_len = max_line_len

    def guard_tool_result(
        self, call_id, capability, ok, payload
    ) -> tuple[dict, BlobPointer | None]:
        payload_text = (
            json.dumps(payload) if isinstance(payload, dict) else str(payload)
        )

        if (
            len(payload_text) <= self.max_chars
            and payload_text.count("\n") <= self.max_lines
        ):
            return (
                {
                    "call_id": call_id,
                    "capability": capability,
                    "ok": ok,
                    "offloaded": False,
                    "payload": payload,
                },
                None,
            )

        blob_id = f'blob_{uuid7()}'
        lines = payload_text.splitlines()
        safe_lines = [
            line[: self.max_line_len] + "...[单行过长已截断]"
            if len(line) > self.max_line_len
            else line
            for line in lines
        ]
        normalized_payload = "\n".join(safe_lines)

        if (
            len(normalized_payload) <= self.max_chars
            and len(safe_lines) <= self.max_lines
        ):
            return (
                {
                    "call_id": call_id,
                    "capability": capability,
                    "ok": ok,
                    "offloaded": False,
                    "payload": payload,
                },
                None,
            )

        head_chars, tail_chars = self.preview_chars // 2, self.preview_chars // 2
        head_part = normalized_payload[:head_chars]
        tail_part = (
            normalized_payload[-tail_chars:]
            if len(normalized_payload) > head_chars
            else ""
        )
        omitted_chars = len(payload_text) - len(head_part) - len(tail_part)
        preview_text = (
            f"{head_part}\n\n"
            f"================================================================\n"
            f"⚠️ [系统截断提示] 原始工具输出过长（共 {len(payload_text)} 字符 / {len(lines)} 行，已省略中间约 {omitted_chars} 字符）。\n"
            f"📁 完整未删减内容已保存至本地文件: `{self.blob_dir}`\n"
            f'💡 如需查看中间被省略的具体内容，请调用 `read_file_lines(path="{self.blob_dir}", start_line=..., end_line=...)` 或使用 `grep_file` 搜索关键词。\n'
            f"================================================================\n\n"
            f"{tail_part}"
        )

        blob_dir = Path(self.blob_dir)
        file_path = blob_dir / f"{blob_id}.txt"
        blob_dir.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(payload_text)
        blob_pointer = BlobPointer(
            blob_id=str(blob_id),
            file_path=str(file_path),
            original_chars=len(payload_text),
            estimated_chars=len(preview_text),
            preview=preview_text,
        )
        blob_dict = {
            "callId": call_id,
            "capability": capability,
            "ok": ok,
            "offloaded": True,
            "blobId": str(blob_id),
            "filePath": str(file_path),
            "preview": preview_text,
            "original_chars": len(payload_text),
        }
        return blob_dict, blob_pointer

    def read_blob(self, blob_id_or_path:str)->str:
        """
        Read the content of a blob file given its ID or path.
        """
        if Path(blob_id_or_path).exists():
            file_path = Path(blob_id_or_path)
        else:
            # Assuming blob_id is provided, construct the file path
            file_path = Path(self.blob_dir) / f"{blob_id_or_path}.txt"

        if not file_path.exists():
            raise FileNotFoundError(f"Blob file not found: {file_path}")

        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()