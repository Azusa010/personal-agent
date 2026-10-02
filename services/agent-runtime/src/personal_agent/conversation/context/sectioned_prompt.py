"""SectionedSystemPrompt —— XML 分段式系统提示词与差分更新管理器。

基于 PI Agent (earendil-works/pi) 的缓存友好设计范式与《AI Agent 开发实战》第五章理论规范：
1. 显式 XML 分段结构：通过 <preamble>, <tools>, <rules>, <skills>, <project_context>, <environment> 等标签组织；
2. 缓存敏感排序：静态段（preamble, tools, rules）置于顶部（KV Cache 命中率高），动态段（environment）置于末尾；
3. 差分增量渲染：通过 render_diff() 只输出发生变更或新增的 XML 片段，无变更返回 None，并对删除段输出墓碑标记；
4. 字典与序列兼容性：提供 get/set/delete、迭代、dirty 检测与切片拷贝等完整操作。
5. 差分应用与双向同步：提供 apply_patch / parse_diff_xml / apply_diff_xml，支持差分补丁重水化与 KV Cache 命中度量。
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence

SECTION_NAME_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")

DEFAULT_SECTION_ORDER: tuple[str, ...] = (
    "preamble",
    "tools",
    "rules",
    "skills",
    "project_context",
    "environment",
)


class SectionedSystemPrompt:
    """分段式系统提示词，支持 XML 分段与差分更新。"""

    def __init__(
        self,
        sections: Mapping[str, str] | None = None,
        section_order: Sequence[str] | None = None,
    ) -> None:
        self._sections: dict[str, str] = {}
        self._last_rendered: dict[str, str] = {}
        self._section_order: list[str] | None = (
            list(section_order) if section_order is not None else None
        )
        if sections:
            for name, content in sections.items():
                self.set_section(name, content)

    @property
    def section_order(self) -> tuple[str, ...] | None:
        """配置的段落排序序列；若为 None 则遵循字典插入顺序。"""
        return tuple(self._section_order) if self._section_order is not None else None

    @section_order.setter
    def section_order(self, order: Sequence[str] | None) -> None:
        self._section_order = list(order) if order is not None else None

    @property
    def sections(self) -> dict[str, str]:
        """当前所有段落快照（只读浅拷贝）。"""
        return dict(self._sections)

    @property
    def last_rendered(self) -> dict[str, str]:
        """上一次成功渲染时的段落快照（只读浅拷贝）。"""
        return dict(self._last_rendered)

    @property
    def is_dirty(self) -> bool:
        """检查当前段落状态与上一次渲染快照是否存在差异。"""
        return self._sections != self._last_rendered

    @property
    def section_names(self) -> list[str]:
        """返回有序的段落名称列表。"""
        return [name for name, _ in self._ordered_items()]

    def _validate_section_name(self, name: str) -> None:
        if not isinstance(name, str) or not SECTION_NAME_PATTERN.match(name):
            raise ValueError(
                f"非法段落标签名称 '{name}'。名称必须以字母开头，且仅包含字母、数字、下划线或连字符。"
            )

    def set_section(self, name: str, content: str) -> None:
        """添加或更新指定段落。"""
        self._validate_section_name(name)
        if not isinstance(content, str):
            raise TypeError(f"段落内容必须是 str，收到 {type(content).__name__}")
        self._sections[name] = content.strip()

    def set_sections(self, sections: Mapping[str, str]) -> None:
        """批量设置段落。"""
        for name, content in sections.items():
            self.set_section(name, content)

    def get_section(self, name: str, default: str | None = None) -> str | None:
        """获取指定段落的内容；不存在时返回 default。"""
        return self._sections.get(name, default)

    def has_section(self, name: str) -> bool:
        """判断是否存在指定段落。"""
        return name in self._sections

    def remove_section(self, name: str) -> bool:
        """删除指定段落。若成功删除返回 True，段落不存在返回 False。"""
        if name in self._sections:
            del self._sections[name]
            return True
        return False

    def clear(self) -> None:
        """清空所有段落。"""
        self._sections.clear()

    def mark_rendered(self) -> None:
        """手动将当前段落快照标记为已渲染（同步 _last_rendered）。"""
        self._last_rendered = dict(self._sections)

    def reset_rendered(self) -> None:
        """重置已渲染记录，使后续 render_diff() 将所有现有段落识别为新变更。"""
        self._last_rendered.clear()

    def _ordered_items(self) -> list[tuple[str, str]]:
        """按配置的 section_order 或插入顺序返回有序的 (name, content) 列表。"""
        if not self._section_order:
            return list(self._sections.items())

        ordered: list[tuple[str, str]] = []
        seen = set()
        for name in self._section_order:
            if name in self._sections:
                ordered.append((name, self._sections[name]))
                seen.add(name)
        for name, content in self._sections.items():
            if name not in seen:
                ordered.append((name, content))
        return ordered

    def render_full(self) -> str:
        """首次或全量渲染：输出完整 XML 结构化系统提示词。

        每个段落包裹在 `<name>\\n{content}\\n</name>` 中，段落之间用双换行分隔。
        渲染完成后同步更新 _last_rendered。
        """
        parts = []
        for name, content in self._ordered_items():
            parts.append(f"<{name}>\n{content}\n</{name}>")
        self._last_rendered = dict(self._sections)
        return "\n\n".join(parts)

    def diff_sections(self) -> dict[str, str | None] | None:
        """计算相对于上一次渲染的变化字典（对齐 PI Agent diffSystemPromptSections）。

        返回新增/修改的段落 (name -> content) 以及已删除的段落 (name -> None)。
        若无任何变化，返回 None。
        注意：本方法不会隐式更新 _last_rendered 状态。
        """
        patch: dict[str, str | None] = {}
        for name, content in self._sections.items():
            if self._last_rendered.get(name) != content:
                patch[name] = content
        for name in self._last_rendered:
            if name not in self._sections:
                patch[name] = None

        return patch if patch else None

    def _order_names(self, names: Iterable[str]) -> list[str]:
        name_set = set(names)
        ordered: list[str] = []
        seen = set()
        if self._section_order:
            for n in self._section_order:
                if n in name_set:
                    ordered.append(n)
                    seen.add(n)
        for n in self._sections:
            if n in name_set and n not in seen:
                ordered.append(n)
                seen.add(n)
        for n in self._last_rendered:
            if n in name_set and n not in seen:
                ordered.append(n)
                seen.add(n)
        return ordered

    def render_diff(self) -> str | None:
        """增量渲染：仅输出发生变更或新增的段落片段。

        若某个段落被删除，输出 `<name status="deleted"/>` 墓碑标记。
        若没有任何变更，返回 None。
        渲染完成后同步更新 _last_rendered。
        """
        patch = self.diff_sections()
        if not patch:
            return None
        parts = []
        ordered_keys = self._order_names(patch.keys())
        for name in ordered_keys:
            content = patch[name]
            if content is not None:
                parts.append(f"<{name}>\n{content}\n</{name}>")
            else:
                parts.append(f'<{name} status="deleted"/>')
        self._last_rendered = dict(self._sections)
        return "\n\n".join(parts)

    def apply_patch(self, patch: Mapping[str, str | None]) -> None:
        """应用差分补丁字典（包含新增、修改或 None 删除）。"""
        for name, content in patch.items():
            if content is None:
                self.remove_section(name)
            else:
                self.set_section(name, content)

    @classmethod
    def parse_diff_xml(cls, xml_diff: str) -> dict[str, str | None]:
        """解析包含 XML 增量段落的文本为补丁字典。

        匹配 `<tag status="deleted"/>` 为 None，
        匹配 `<tag>content</tag>` 为 content.strip()。
        """
        patch: dict[str, str | None] = {}
        # 匹配删除标记：<tag status="deleted"/>
        deleted_pattern = re.compile(
            r'<([a-zA-Z][a-zA-Z0-9_-]*)\s+status="deleted"\s*/>'
        )
        for match in deleted_pattern.finditer(xml_diff):
            tag = match.group(1)
            patch[tag] = None

        # 匹配内容段落：<tag>...</tag>
        content_pattern = re.compile(
            r"<([a-zA-Z][a-zA-Z0-9_-]*)>(.*?)</\1>",
            re.DOTALL,
        )
        for match in content_pattern.finditer(xml_diff):
            tag = match.group(1)
            content = match.group(2).strip()
            patch[tag] = content

        return patch

    def apply_diff_xml(self, xml_diff: str) -> None:
        """解析 XML 增量文本并应用到当前提示词实例中。"""
        patch = self.parse_diff_xml(xml_diff)
        self.apply_patch(patch)

    @staticmethod
    def calculate_common_prefix_length(str1: str, str2: str) -> int:
        """计算两个字符串从头开始相同的字符数（用于评估 KV Cache 命中深度）。"""
        min_len = min(len(str1), len(str2))
        for i in range(min_len):
            if str1[i] != str2[i]:
                return i
        return min_len

    @staticmethod
    def calculate_kv_cache_ratio(prompt1: str, prompt2: str) -> float:
        """计算 prompt2 相对于 prompt1 的 KV Cache 理论命中比例（基于公共前缀长度）。"""
        if not prompt1 or not prompt2:
            return 0.0
        prefix_len = SectionedSystemPrompt.calculate_common_prefix_length(
            prompt1, prompt2
        )
        return prefix_len / len(prompt2)

    def clone(self) -> SectionedSystemPrompt:
        """深拷贝一份提示词管理器实例。"""
        new_prompt = SectionedSystemPrompt(
            sections=self._sections,
            section_order=self._section_order,
        )
        new_prompt._last_rendered = dict(self._last_rendered)
        return new_prompt

    def __getitem__(self, name: str) -> str:
        if name not in self._sections:
            raise KeyError(f"未找到段落 '{name}'")
        return self._sections[name]

    def __setitem__(self, name: str, content: str) -> None:
        self.set_section(name, content)

    def __delitem__(self, name: str) -> None:
        if not self.remove_section(name):
            raise KeyError(f"未找到段落 '{name}'")

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._sections

    def __len__(self) -> int:
        return len(self._sections)

    def __str__(self) -> str:
        parts = []
        for name, content in self._ordered_items():
            parts.append(f"<{name}>\n{content}\n</{name}>")
        return "\n\n".join(parts)

    def __repr__(self) -> str:
        return f"<SectionedSystemPrompt sections={list(self._sections.keys())} dirty={self.is_dirty}>"
