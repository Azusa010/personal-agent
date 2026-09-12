"""
planning.py —— 计划生成。
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


def make_plan(goal: str, visibleCapabilities: Sequence[str]) -> list[PlanStep]:
    """按目标产出一份有序计划。

    Parameters:：
    - goal：用户的目标文本。契约层已经拦过空串（min_length=1），这里不重复校验。
      Phase 2 不参与判定——计划是固定三步，goal 只是带着走，将来做动态规划时才用。
    - visibleCapabilities：握手时 Main 下发、存在 RuntimeDeps.capabilities 里的能力名，
      也就是模型这一步真正能看见的清单。runtime.py 的 handle_make_plan 会传
      [c.name for c in deps.capabilities]。
    """
    for required in ("filesystem.list", "document.extract_pdf"):
        if required not in visibleCapabilities:
            raise PlanError(f"计划需要 {required}，但它不在模型可见的能力清单里")
    return [
        PlanStep(description="列出 Downloads 下的 PDF", capability="filesystem.list"),
        PlanStep(
            description="提取目标 PDF 的每页文本", capability="document.extract_pdf"
        ),
        PlanStep(description="基于页面内容生成带页码引用的摘要"),
    ]
