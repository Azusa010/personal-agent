"""双轨工作文档管理器（ProgressDocumentManager）：持久化认知外化与增量事实沉淀。"""

from collections.abc import Sequence

from personal_agent.conversation.compression.models import (
    DistilledFact,
    ProgressDocumentState,
    TaskType,
)

DOCUMENT_OPEN_TAG = "<progress_document>"
DOCUMENT_CLOSE_TAG = "</progress_document>"


class ProgressDocumentManager:
    """管理任务的持久化工作文档状态，负责事实去重合并、里程碑记录与工作台渲染。"""

    def __init__(
        self,
        task_goal: str = "",
        task_type: TaskType = TaskType.RETRIEVAL,
    ) -> None:
        self._state = ProgressDocumentState(
            taskGoal=task_goal,
            taskType=task_type,
        )

    @property
    def state(self) -> ProgressDocumentState:
        """只读状态快照。"""
        return self._state

    def add_milestone(self, description: str) -> None:
        """记录一条推进中的或已达成的里程碑。"""
        if description.strip():
            self._state.milestones.append(description.strip())

    def add_note(self, note: str) -> None:
        """记录 Agent 主动沉淀的阶段性洞察或重要提示。"""
        if note.strip():
            self._state.notes.append(note.strip())

    def merge_facts(self, facts: Sequence[DistilledFact]) -> int:
        """
        将新提炼的一批结构化事实增量、去重地合并到工作文档中。
        """
        existing_keys = {
            (
                f.subject.strip(),
                f.predicate.strip(),
                f.object.strip(),
                (f.temporal or "").strip(),
            )
            for f in self._state.verifiedFacts
        }
        added_count = 0
        for fact in facts:
            key = (
                fact.subject.strip(),
                fact.predicate.strip(),
                fact.object.strip(),
                (fact.temporal or "").strip(),
            )
            if key not in existing_keys:
                self._state.verifiedFacts.append(fact)
                existing_keys.add(key)
                added_count += 1
            else:
                # 若已存在相同事实，合并可能新出现的引用页码 pageRefs
                for existing in self._state.verifiedFacts:
                    if (
                        existing.subject.strip(),
                        existing.predicate.strip(),
                        existing.object.strip(),
                        (existing.temporal or "").strip(),
                    ) == key:
                        for page in fact.pageRefs:
                            if page not in existing.pageRefs:
                                existing.pageRefs.append(page)
                        break
        return added_count

    def render(self) -> str:
        """将当前工作文档状态渲染为结构化 Markdown 认知工作台。"""
        lines = [
            DOCUMENT_OPEN_TAG,
            f"# 任务认知工作台: {self._state.taskGoal} [{self._state.taskType.value}]",
            "",
            "## 已确认的核心事实",
        ]
        if not self._state.verifiedFacts:
            lines.append("- （暂无事实）")
        else:
            for f in self._state.verifiedFacts:
                time_prefix = f"[{f.temporal}] " if f.temporal else ""
                obj_suffix = f" {f.object}" if f.object else ""
                refs_suffix = f" (来源页码: {f.pageRefs})" if f.pageRefs else ""
                lines.append(f"- {time_prefix}{f.subject} {f.predicate}{obj_suffix}{refs_suffix}")
        lines.extend(["", "## 执行进展与里程碑"])
        if not self._state.milestones:
            lines.append("- （暂无里程碑）")
        else:
            for m in self._state.milestones:
                lines.append(f"- {m}")
        lines.extend(["", "## 洞察与工作笔记"])
        if not self._state.notes:
            lines.append("- （暂无笔记）")
        else:
            for n in self._state.notes:
                lines.append(f"- {n}")
        lines.extend(["", DOCUMENT_CLOSE_TAG])
        return "\n".join(lines)