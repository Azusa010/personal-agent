"""
planning.py —— 计划生成。

这里是「固定计划」的实现：两个 READ 打底、三个 WRITE 按可见性追加、末尾一步
摘要。剧本、CI、E2E 与演示都走它，所以它
对同一个 (goal, visibleCapabilities) 永远给同一份计划。

按目标出计划的实现是 planner.LivePlanner，与这里并列挂在 planner.Planner 端口下。
"""

from collections.abc import Sequence

from pydantic import BaseModel, Field

from personal_agent.protocol.models import CapabilityId


class PlanError(ValueError):
    """计划生成不出来：需要的能力不在模型可见清单里。"""


class PlanStep(BaseModel):
    """
    计划里的一步。字段名与 wire 契约的 PlanStepDto 逐字一致，
    """

    description: str = Field(min_length=1)
    capability: CapabilityId | None = None


# 计划的顺序就是 ActionAlignment 的比对基准（第 i 次放行的调用必须等于第 i 个带
# capability 的步骤）。
#
# 计划按「模型能看见什么」伸缩：
#  - 两个 READ 是硬要求：缺任何一个，计划根本建不出来（PlanError）。
#  - 三个 WRITE 是可选的：可见就进计划，不可见就不进。
#
# 这样同一份 make_plan 既服务生产（握手给五个能力 → 完整 Golden Path），也服务
# Live Eval 那种只读配置（只给两个 READ → 三步计划）。关键是 ActionAlignment 与
# 交付物判定（TASK-026）**都**按计划走，所以三者的口径自动一致：只读计划不会被
# 要求「文件已移动、Reminder 已创建」，完整计划也不会放过没移动就宣布完成的任务。
#
# 摘要排在最后没有 capability：SummaryDecision 是 engine 的终态决策，模型给出摘要
# 之后循环就结束了。所以写操作（建目录 / 移动 / 建提醒）必须发生在摘要之前——用户
# 批准移动、任务落终态、摘要随之交付，这三件事的先后在任务层面看不出差别。
READ_STEPS: tuple[tuple[CapabilityId, str], ...] = (
    ("filesystem_list", "列出 Downloads 下的 PDF"),
    ("document_extract_pdf", "提取目标 PDF 的每页文本"),
)

WRITE_STEPS: tuple[tuple[CapabilityId, str], ...] = (
    ("filesystem_create_dir", "在 Downloads 下创建 Reading 目录"),
    ("filesystem_move", "把选中的 PDF 移到 Reading"),
    ("scheduler_create", "创建一次性阅读提醒"),
)

SUMMARY_STEP_DESCRIPTION = "基于页面内容生成带页码引用的摘要"


def make_plan(goal: str, visibleCapabilities: Sequence[str]) -> list[PlanStep]:
    """按目标产出一份有序计划。

     Parameters:：
    - goal：用户的目标文本。契约层已经拦过空串（min_length=1），这里不重复校验。
       **它不参与决策**：这个实现服务 CI 与演示，必须对同一个目标永远给同一份计划。
       按目标出计划是 planner.LivePlanner 的事。
     - visibleCapabilities：握手时 Main 下发、存在 RuntimeDeps.capabilities 里的能力名，
       也就是模型这一步真正能看见的清单。runtime.py 的 handle_make_plan 会传
       [c.name for c in deps.capabilities]。
    """
    for required, _ in READ_STEPS:
        if required not in visibleCapabilities:
            raise PlanError(f"计划需要 {required}，但它不在模型可见的能力清单里")
    steps = [
        PlanStep(description=description, capability=capability)
        for capability, description in READ_STEPS
    ]
    steps += [
        PlanStep(description=description, capability=capability)
        for capability, description in WRITE_STEPS
        if capability in visibleCapabilities
    ]
    return steps + [PlanStep(description=SUMMARY_STEP_DESCRIPTION)]
