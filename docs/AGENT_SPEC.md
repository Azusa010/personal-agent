# PersonalAgent 元能力体系与工作区约定规范 (`docs/AGENT_SPEC.md`)

> 依据《AI Agent 开发实战》第五章「代码：通用 Agent 的元能力」与 [PI Agent](https://github.com/earendil-works/pi) Exemplar 架构，
> 制定 PersonalAgent 工作区能力固化、技能规范与自举演进标准。

---

## 一、工作区 `.agent/` 目录组织规范

在任何授权工作区根目录下，PersonalAgent 维护受控的 `.agent/` 目录：

```
<workspace>/
  .agent/
    README.md                      ← 工作区内开发指引与规范说明
    tools/                         ← 固化工具脚本库
      template_tool.py             ← 标准工具脚手架模板
      <tool_name>.py               ← 动态固化的具名工具脚本
    skills/                        ← 技能卡库（对齐 Agent Skills Specification）
      template-skill/
        SKILL.md                   ← 标准技能卡模板
      <skill-name>/
        SKILL.md                   ← 动态固化的具名技能卡
    exemplars/                     ← Exemplar 基因模板库
      pi/                          ← 标杆 Exemplar：PI Agent
        ARCHITECTURE.md            ← PI Agent 架构分析与 PersonalAgent 映射参考
        template/                  ← PI Agent 核心源码直接模板
          agent-loop.ts            ← 状态机调度主循环模板
          system-prompt.ts         ← XML 分段式提示词生成器模板
          skills.ts                ← 技能扫描引擎与 ignore 规范模板
          agent-types.ts           ← AgentTool 与系统契约接口模板
          extension-loader.ts      ← 动态扩展热加载机制模板
          tools-registry.ts        ← 工具自描述注册表模板
```

---

## 二、工具脚本编写准则 (`.agent/tools/`)

1. **元数据头部完整性**：
   每个 Python 脚本必须以标准 Docstring 开头，注明 `Tool`, `Description`, `Version`, `Created`, `Tags`, `Usage`, `Input`, `Output`, `Exit Codes`。
2. **严格的 IO 隔离**：
   - 宿主与 Agent 通过标准输出流（stdout）交换结构化数据，因此 stdout **必须且只能**输出合法 JSON（如 `{"ok": true, ...}`）。
   - 所有运行时日志、调试追踪、警告等必须严格定向至标准错误流（stderr）。
3. **确定性退出码**：
   - `0`: 成功完成。
   - `1`: 参数校验失败（缺少参数、类型不匹配）。
   - `2`: 业务逻辑错误（目标文件不存在、数据损坏）。
   - `3`: 运行时未捕获异常或环境崩溃。
4. **安全沙箱与 Path-Guard**：
   所有工具接收的文件路径必须经 `resolveWithinRootReal` 校验，不得超越授权工作区根目录。

---

## 三、技能卡编写准则 (`.agent/skills/`)

严格遵循 [Agent Skills Specification](https://agentskills.io/specification)：

1. **YAML Frontmatter**：
   ```yaml
   ---
   name: <kebab-case-name>       # 小写字母、数字、短横线，最大 64 字符
   description: <description>   # 单句核心描述，最大 1024 字符
   tags: [tag1, tag2]           # 检索标签
   exposure: direct             # direct(默认进入工具列表) / deferred(仅按需检索)
   ---
   ```
2. **规范化章节骨架**：
   - `# <Skill Name>`
   - `## 何时使用`：触发意图与边界判断
   - `## 使用方法`：具体命令行调用格式示例
   - `## 输入输出契约`：详细字段与退出码列表
   - `## 注意事项与安全约束`：资源、超时与权限限制

---

## 四、Exemplar 复制与自举机制（PI Agent 为模板）

从零凭空生成 Agent 逻辑容易产生接口断裂、语法漂移与错误处理脆弱。
本项目直接采用 **PI Agent 核心源码作为模板**，结合分析完备的架构参考（`ARCHITECTURE.md`），构建自举复制流水线：

```
                       ┌─────────────────────────┐
                       │  .agent/exemplars/pi/   │
                       │  • 核心源码模板 (template) │
                       │  • 架构分析 (ARCHITECTURE)│
                       └────────────┬────────────┘
                                    │ ① 检视模板 & 提取契约
                                    ▼
                       ┌─────────────────────────┐
                       │  code_interpreter:      │
                       │  即兴编写并验证适配脚本   │
                       └────────────┬────────────┘
                                    │ ② 验证 exitCode === 0 & stdout JSON
                                    ▼
                       ┌─────────────────────────┐
                       │  file_write 落盘固化:    │
                       │  • .agent/tools/        │
                       │  • .agent/skills/       │
                       └────────────┬────────────┘
                                    │ ③ 技能发现引擎自动感知
                                    ▼
                       ┌─────────────────────────┐
                       │  后续任务直接复用该能力    │
                       └─────────────────────────┘
```

这一流水线确保了新生成的工具具备工业级标准与高度自洽性。
