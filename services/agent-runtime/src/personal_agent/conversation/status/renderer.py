"""状态栏渲染流水线（Renderer）。"""

from collections.abc import Sequence

from personal_agent.conversation.status.models import StatusBarState
from personal_agent.conversation.status.providers import (
    StatusBarSectionProvider,
    SystemInfoProvider,
    TodoPlanProvider,
    ToolStatsProvider,
)

STATUS_BAR_OPEN_TAG = "<status_bar>"
STATUS_BAR_CLOSE_TAG = "</status_bar>"


class StatusBarRenderer:
    """组合可扩展 Provider 流水线，将状态快照渲染为 Markdown 格式的完整状态栏。"""

    def __init__(
        self,
        providers: Sequence[StatusBarSectionProvider] | None = None,
    ) -> None:
        if providers is None:
            # 默认内置三大提供者
            self._providers: list[StatusBarSectionProvider] = [
                SystemInfoProvider(),
                ToolStatsProvider(),
                TodoPlanProvider(),
            ]
        else:
            self._providers = list(providers)

        # 按优先级升序排序（priority 越小越先渲染）
        self._providers.sort(key=lambda p: p.priority)

    @property
    def providers(self) -> tuple[StatusBarSectionProvider, ...]:
        return tuple(self._providers)

    def render(self, state: StatusBarState) -> str:
        """遍历所有 Provider，渲染非空区块并包裹于 <status_bar> XML 标记中。

        若所有区块皆为空，则返回空字符串。
        """
        blocks: list[str] = []
        for provider in self._providers:
            block = provider.render(state)
            if block and block.strip():
                blocks.append(block.strip())

        if not blocks:
            return ""

        content = "\n\n".join(blocks)
        return f"{STATUS_BAR_OPEN_TAG}\n{content}\n{STATUS_BAR_CLOSE_TAG}"
