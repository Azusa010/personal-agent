"""workflow/golden_path.py —— 整理 PDF 场景的标准确定性工作流。"""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from personal_agent.protocol.models import SummaryFact
from personal_agent.workflow.definition import (
    WorkflowDefinition,
    WorkflowState,
    WorkflowStep,
)


class WorkflowPlanError(ValueError):
    """工作流构建失败：缺少必需的底层能力。"""


def _find_target_pdf(state: WorkflowState) -> dict[str, Any]:
    """从 list_files 步骤产物中寻找第一份目标 PDF 文件。"""
    list_res = state.get_result("list_files") or {}
    entries = list_res.get("entries") or []
    for entry in entries:
        name = entry.get("name", "")
        if name.lower().endswith(".pdf"):
            return entry
    raise ValueError("未在目标目录中找到任何 PDF 文件")


def _reading_dir_path(pdf_path: str) -> str:
    """计算与 PDF 同级的 Reading 目录路径。"""
    return str(Path(pdf_path).parent / "Reading")


def _target_move_path(pdf_path: str, pdf_name: str) -> str:
    """计算 PDF 移入 Reading 后的目标路径。"""
    return str(Path(pdf_path).parent / "Reading" / pdf_name)


def _generate_future_remind_time(hours: int = 1) -> str:
    """生成未来时刻的 ISO-8601 UTC 时间戳。"""
    future = datetime.now(UTC) + timedelta(hours=hours)
    return future.isoformat(timespec="seconds").replace("+00:00", "Z")


def build_golden_path_workflow(
    visible_capabilities: Sequence[str],
) -> WorkflowDefinition:
    """按可见能力构建 Golden Path 确定性工作流。

    - 两个 READ 能力必须可见（fail-closed）；
    - 三个 WRITE 能力按可见性追加；
    - 收尾自动从真实解析页码中抽取 SummaryFact。
    """
    if (
        "filesystem_list" not in visible_capabilities
        or "document_extract_pdf" not in visible_capabilities
    ):
        raise WorkflowPlanError(
            "缺少必需能力：filesystem_list 与 document_extract_pdf 必须全部可用"
        )

    steps: list[WorkflowStep] = []

    # 1. 扫描文件
    steps.append(
        WorkflowStep(
            id="list_files",
            capability="filesystem_list",
            description="列出 Downloads 下的 PDF",
            resolve_args=lambda s: {"rootId": s.inputs.get("rootId", "downloads")},
        )
    )

    # 2. 提取页面
    steps.append(
        WorkflowStep(
            id="extract_pdf",
            capability="document_extract_pdf",
            description="提取目标 PDF 的每页文本",
            resolve_args=lambda s: {"path": _find_target_pdf(s)["path"]},
        )
    )

    # 3. 创建 Reading 目录（可选）
    if "filesystem_create_dir" in visible_capabilities:
        steps.append(
            WorkflowStep(
                id="create_dir",
                capability="filesystem_create_dir",
                description="在 Downloads 下创建 Reading 目录",
                resolve_args=lambda s: {
                    "path": _reading_dir_path(_find_target_pdf(s)["path"])
                },
            )
        )

    # 4. 移动 PDF（可选）
    has_move = "filesystem_move" in visible_capabilities
    if has_move:
        steps.append(
            WorkflowStep(
                id="move_pdf",
                capability="filesystem_move",
                description="把选中的 PDF 移到 Reading",
                resolve_args=lambda s: {
                    "source": _find_target_pdf(s)["path"],
                    "target": _target_move_path(
                        _find_target_pdf(s)["path"], _find_target_pdf(s)["name"]
                    ),
                },
            )
        )

    # 5. 创建提醒（可选）
    if "scheduler_create" in visible_capabilities:
        steps.append(
            WorkflowStep(
                id="create_reminder",
                capability="scheduler_create",
                description="创建一次性阅读提醒",
                resolve_args=lambda s: {
                    "remindAt": _generate_future_remind_time(1),
                    "message": f"请阅读文件 {_find_target_pdf(s)['name']}",
                },
            )
        )

    # 摘要产出器
    def produce_summary(state: WorkflowState) -> tuple[str, list[SummaryFact]]:
        target = _find_target_pdf(state)
        extract_res = state.get_result("extract_pdf") or {}
        pages = extract_res.get("pages") or []

        facts: list[SummaryFact] = []
        for p in pages:
            page_num = p.get("pageNumber")
            text = (p.get("text") or "").strip()
            first_line = text.splitlines()[0] if text else f"第 {page_num} 页要点"
            if isinstance(page_num, int):
                facts.append(SummaryFact(text=first_line[:100], pageRefs=[page_num]))

        if has_move:
            reply = f"已把 {target['name']} 移到 Reading，并建了一条到点的一次性阅读提醒。摘要：共 {len(pages)} 页已处理完成。"
        else:
            reply = f"已完成 {target['name']} 的内容提取，共 {len(pages)} 页。"

        return reply, facts

    return WorkflowDefinition(
        id="golden_path",
        name="整理 Downloads 里的 PDF",
        description="扫描、提取、归档并创建阅读提醒的标准流程",
        steps=steps,
        produce_summary=produce_summary,
    )