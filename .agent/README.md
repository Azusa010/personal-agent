# PersonalAgent 工作区能力与自举体系约定 (`.agent/`)

> 本目录是 PersonalAgent 在工作区中的能力自举、工具固化与技能沉淀中心。
> 遵循《AI Agent 开发实战》第五章「代码：通用 Agent 的元能力」规范与 [PI Agent](https://github.com/earendil-works/pi) Exemplar 模板标准。

---

## 1. 目录结构全景

```
<workspace>/
  .agent/
    README.md                      ← 本说明文档（目录约定与编写规范）
    tools/                         ← 固化工具脚本库（可执行 Python/Shell）
      template_tool.py             ← 标准工具脚本脚手架模板
      <tool_name>.py               ← Agent 动态自举生成的具名工具
    skills/                        ← 技能卡目录（对齐 Agent Skills Specification）
      template-skill/
        SKILL.md                   ← 标准技能卡脚手架模板
      <skill-name>/
        SKILL.md                   ← Agent 动态固化的具名技能卡
    exemplars/                     ← Exemplar 基因模板库（自我复制与演进蓝本）
      pi/                          ← 标杆 Exemplar：PI Agent 模板体系
        ARCHITECTURE.md            ← PI Agent 架构解构与深入参考
        template/                  ← PI Agent 核心源码直接模板
          agent-loop.ts            ← 状态机与主循环调度源码模板
          system-prompt.ts         ← XML 分段式提示词构建源码模板
          skills.ts                ← 技能扫描与渐进披露源码模板
          agent-types.ts           ← AgentTool 与系统契约定义模板
          extension-loader.ts      ← 动态扩展热加载机制模板
          tools-registry.ts        ← 工具自描述注册表模板
```

---

## 2. 工具脚本开发规范 (`.agent/tools/`)

固化在 `.agent/tools/` 下的所有工具脚本必须严格遵循以下质量准则：

### 2.1 头部元数据 Docstring 规范
每个脚本开头必须包含标准化注释块，说明工具用途、调用参数与返回值：

```python
#!/usr/bin/env python3
"""
Tool: <tool_name>
Description: <清晰准确的功能描述，说明工具解决的具象问题>
Version: 1.0.0
Created: YYYY-MM-DD
Tags: tag1, tag2, tag3

Usage:
    python <tool_name>.py --param1 <value> [--param2 <value>]

Input:
    --param1 (type): 参数说明
    --param2 (type, optional): 可选参数说明

Output:
    stdout: 纯净 JSON 格式的业务执行结果
    stderr: 诊断日志、调试追踪信息，严禁输出业务数据

Exit Codes:
    0: 执行成功
    1: 命令行参数非法或校验未通过
    2: 业务逻辑失败或资源未就绪
    3: 运行时未捕获异常或环境崩溃
"""
```

### 2.2 IO 分离原则
- **标准输出 (stdout)**：必须是纯净、合法的 JSON 字符串（格式如 `{"ok": true, "data": ...}` 或 `{"ok": false, "code": "...", "error": "..."}`）。执行成功或业务受控失败时，宿主仅解析 stdout。
- **标准错误 (stderr)**：用于承载所有人类可读的进度日志、网络调试信息、调用追踪等。任何 print 调试信息严禁流入 stdout，防止宿主反序列化崩溃。

### 2.3 规范退出码映射
- `0`: 成功处理完毕。
- `1`: 参数错误（例如缺少必填参数、参数格式非法）。
- `2`: 业务可预期失败（例如目标文件未找到、权限校验不符）。
- `3`: 不可预期崩溃（例如底层驱动错误、语法异常）。

---

## 3. 技能卡编写规范 (`.agent/skills/`)

每个固化工具必须在 `.agent/skills/<skill-name>/` 下配套一份 `SKILL.md`，严格遵循 [Agent Skills Specification](https://agentskills.io/specification)：

### 3.1 YAML Frontmatter
```yaml
---
name: <kebab-case-name>       # 必须为全小写、数字、连字符组合，最大长度 64 字符
description: <description>   # 极简摘要说明，用于初始提示词阶段注入（最大 1024 字符）
tags: [tag1, tag2]           # 分类标签，便于 skill_search 检索
exposure: direct             # 可选 direct(默认暴露) / deferred(仅检索发现) / internal
---
```

### 3.2 必备文档小节
1. `# <Skill Name>`：主标题。
2. `## 何时使用`：明确触发条件，说明什么意图下调用此技能最有效。
3. `## 使用方法`：给出通过 `code_interpreter` 或 `terminal_execute` 调用的具象 bash 命令示例。
4. `## 输入输出契约`：列出必填/可选参数、stdout JSON 的具体字段定义及退出码释义。
5. `## 注意事项与安全约束`：标明路径合法性要求、超时限制、文件大小限制等防御性约束。

---

## 4. Exemplar 模板使用与自举演进 (`.agent/exemplars/`)

当 Agent 遭遇现有工具无法直接解决的全新任务或复杂编排时，应按以下四步流水线进行自举演进：

1. **查阅 Exemplar 基因蓝本**：
   - 研读 `.agent/exemplars/pi/ARCHITECTURE.md` 理解架构模式。
   - 参考 `.agent/exemplars/pi/template/` 中的权威源码设计契约。
2. **即兴脚本与沙箱验证**：
   - 调用 `code_interpreter` 在 `.scratch/` 沙盒内编写并运行验证脚本。
   - 验证退出码为 0，且输出符合 JSON 契约。
3. **工具固化落盘**：
   - 调用 `file_write` 将验证通过的脚本写入 `.agent/tools/<tool_name>.py`。
   - 同步在 `.agent/skills/<tool-name>/SKILL.md` 写入配套使用指导书。
4. **动态索引与长效复用**：
   - PersonalAgent 的 `skills.ts` 插件会自动扫描 `.agent/skills/` 目录。
   - 后续相似任务通过 `skill_search` 即可直接发现该能力，实现持续的自我进化。

---

## 5. 安全与合规底线

1. **Path-Guard 边界覆盖**：所有生成的工具和技能卡必须落在工作区授权根内，严禁逃逸至未授权目录。
2. **写操作审计**：涉及磁盘修改的工具调用需遵循 `expected_*` 预检机制。
3. **无缝隔离**：未经过沙箱验证的代码绝不直接固化入 `.agent/tools/`。
