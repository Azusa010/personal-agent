"""
planner.py 计划生成

- DeterministicPlanner：包装 planning.make_plan。剧本、CI、E2E 与演示走它
- LivePlanner：配了 OPENAI_MODEL 时由真模型按目标产出计划。
"""

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from personal_agent.planning import PlanStep, make_plan


@runtime_checkable
class Planner(Protocol):
    """计划生成器。"""

    def plan(
        self, goal: str, visibleCapabilities: Sequence[str]
    ) -> list[PlanStep]:
        """按目标产出一份有序计划。

        Parameters:
        - goal：用户的目标文本
        - visible_capabilities：可见能力清单
          planning.make_plan 的返回值给它
        """
        pass


class DeterministicPlanner:
    """
    固定计划
    """

    def plan(self, goal: str, visibleCapabilities: Sequence[str]) -> list[PlanStep]:
        return make_plan(goal, visibleCapabilities)


if __name__ == "__main__":
    d = DeterministicPlanner()
    print(isinstance(d,Planner))
    print(issubclass(DeterministicPlanner,Planner))