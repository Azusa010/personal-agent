# PI Agent 架构解构与 Exemplar 模板参考

> 本文档针对 [PI Agent (earendil-works/pi)](https://github.com/earendil-works/pi) 进行深度架构分析与设计解构，配合同目录下的 `template/` 核心源码模板，作为 PersonalAgent 在**自举演进（Self-Bootstrapping）与能力复制**时的权威基因蓝本。

---

## 1. 核心定位与设计哲学

在通用 Coding Agent 的演进中，**"从零自发编写代码"极易遭遇上下文漂移、缺乏边界防御、错误处理退化等问题**。《AI Agent 开发实战》第五章揭示：最稳健的自举范式是以高质量的 Exemplar（基因模板）为蓝图进行"自我复制并适应性修改"。

PI Agent 作为业界领先的极简、模块化 Coding Agent 标杆，其设计具备以下四个核心哲学：
1. **Cache-First 上下文设计**：通过 XML 分段式 System Prompt 与严格的段落顺序管理，极大化利用 LLM 服务端的 Prompt Caching（KV Cache 命中率通常可达 80%~95%）。
2. **渐进式技能披露（Progressive Disclosure）**：不在提示词中一次性展开所有指导书，而是仅暴露名称、一句话描述与路径；需要时由 Agent 按需使用工具读取，节约上下文并防注意力稀释。
3. **自描述工具契约（Self-Describing Tool Protocol）**：工具不仅是一个执行函数，而是集成了参数归一化适配器（`prepareArguments`）、执行模式控制（`executionMode`）、幂等回放策略（`replay`）的高内聚单元。
4. **确定性状态机与双队列调度**：通过明确的转向队列（Steering）与后续队列（Follow-up），实现人类中断介入与自主多步执行的严格分离。

---

## 2. 源码模板目录导引 (`.agent/exemplars/pi/template/`)

本项目已直接提取 PI Agent 的核心模块源码置于 `template/` 目录下，作为直接代码模板：

| 源码模板文件 | 原仓库对应位置 | 核心借鉴价值 |
|:---|:---|:---|
| [`agent-loop.ts`](template/agent-loop.ts) | `packages/agent/src/agent-loop.ts` | 核心 ReAct 调度循环、状态机转移、流式输出、工具并发与 Abort 控制 |
| [`system-prompt.ts`](template/system-prompt.ts) | `packages/coding-agent/src/core/system-prompt.ts` | XML 分段式提示词构建、规范化、差分段更新 |
| [`skills.ts`](template/skills.ts) | `packages/coding-agent/src/core/skills.ts` | 严格对齐 Agent Skills 规范的目录扫描、frontmatter 解析与忽略规则 |
| [`agent-types.ts`](template/agent-types.ts) | `packages/agent/src/types.ts` | `AgentTool`, `AgentState`, `AgentContext` 契约定义与钩子规范 |
| [`extension-loader.ts`](template/extension-loader.ts) | `packages/coding-agent/src/core/extensions/loader.ts` | 动态热加载外部代码（jiti 沙箱加载与执行隔离机制） |
| [`tools-registry.ts`](template/tools-registry.ts) | `packages/coding-agent/src/core/tools/index.ts` | 工具目录注册、环境配置检测与自描述封装 |

---

## 3. 关键设计模式深度解构

### 3.1 XML 分段式 System Prompt 与 KV Cache 保护

在传统 Agent 中，每轮对话重新拼接整个字符串格式的 System Prompt，若动态插入了微小变化（如当前时间戳、当前工作目录），会导致大模型服务端的 Prompt Cache 全面失效，推理延迟和 token 费用成倍增加。

PI Agent 在 `system-prompt.ts` 中采用了**XML 显式分段结构**：

```xml
<preamble>
你是具备编程能力的 Agent...
</preamble>

<tools>
read, bash, edit, write 工具定义及约束
</tools>

<rules>
- 严禁盲目全仓扫描
- 业务修改前必须进行预检
</rules>

<skills>
<skill>
  <name>data-cleaner</name>
  <description>规范化表格与 CSV 数据</description>
  <location>.agent/skills/data-cleaner/SKILL.md</location>
</skill>
</skills>

<project_context>
<project_instructions path="AGENTS.md">
...
</project_instructions>
</project_context>

<environment>
- CWD: /workspace/src
- Git Status: clean
</environment>
```

**缓存不变量约束**：
- 静态段（`preamble`, `tools`, `rules`）位于顶部，会话全程保持二进制不变，100% 命中首部 KV Cache。
- 准静态段（`skills`, `project_context`）随工具固化或分支切换偶尔变更。
- 动态段（`environment`）严格放置在提示词最末尾，即使 CWD 或环境变量发生改变，也仅截断末尾极少量的 token 缓存。

### 3.2 自描述工具契约与多执行模式

PI Agent 在 `agent-types.ts` 中定义的 `AgentTool` 接口超越了传统的单纯函数指针，具备自描述属性：

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  /** 执行模式：串行 (sequential) 或 并发 (parallel) */
  executionMode?: "sequential" | "parallel";
  /** 幂等策略：在网络震荡或重试时是否可重放 */
  replay?: "never" | "safe";
  /** 原始参数矫正钩子 */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** 实际执行体 */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}
```

**设计精髓**：
- `prepareArguments` 承担了参数防御与矫正工作（如字符串到数字的容错转换），让执行体免除重复校验。
- `executionMode` 让调度器能够安全地将只读工具（READ）并行批处理，而对破坏性操作（WRITE）严格串行化。
- `replay` 字段显式标注操作幂等性，为后续分布式容灾与断点续跑提供元数据支撑。

### 3.3 渐进式技能披露（Progressive Disclosure）

PI Agent 在 `skills.ts` 中严格实现了 [Agent Skills Specification](https://agentskills.io/specification)：
- **第一层（检索阶段）**：扫描工作区 `.agent/skills/` 目录，仅提取 Frontmatter 中的 `name`、`description` 和文件相对路径，以极简 XML 注入 `<skills>` 段落。
- **第二层（按需读取）**：模型根据用户指令意图检索到对应 skill 后，调用 `skill_read` 读取该目录下的 `SKILL.md` 全文，获取详尽的使用方法、输入输出格式与安全注意事项。
- **第三层（执行调用）**：依据技能文档指引，调用配套的 `.agent/tools/` 脚本或外部 CLI。

---

## 4. PersonalAgent 适配映射矩阵

PersonalAgent 采用 Monorepo 架构（TypeScript Electron 宿主 + Python Agent 运行时），与 PI Agent 的纯 TypeScript 单进程架构在工程落地时有以下映射对齐关系：

| 架构维度 | PI Agent (Exemplar 标杆) | PersonalAgent (本项目适配实现) | 适配说明 |
|:---|:---|:---|:---|
| **语言与进程** | TypeScript / 单进程事件驱动 | Electron TS Host + Python Runtime / JSON-RPC | TS 负责安全鉴权与原生能力，Python 负责推理策略 |
| **工具契约** | `AgentTool` (TypeBox Schema) | `CapabilityPlugin` (Zod + Pydantic 双模型) | 严格遵循协议双端同步与五层安全策略链 |
| **提示词分段** | `system-prompt.ts` (`SystemPromptSections`) | Python `SectionedSystemPrompt` | 同样使用 XML 分段结构，保持 KV Cache 保护哲学 |
| **技能发现** | `skills.ts` (同步扫描 `.pi/skills`) | `plugins/skills.ts` (异步扫描 `.agent/skills`) | 支持 workspace 根下 `.agent/skills/` 发现 |
| **动态加载** | `jiti` 热加载 `.ts` 文件 | `.agent/tools/*.py` + `code_interpreter` | 即兴生成 Python 脚本经沙箱验证后固化落盘 |
| **工具分级** | `exposure: direct/deferred/hidden` | `CapabilityExposure: direct/deferred/internal` | 扩展 `CapabilityDescriptor` 支持暴露分级 |

---

## 5. Exemplar 自我复制与衍生 SOP

当 PersonalAgent 遭遇未知需求，需要动态自举新能力时，严格按照以下标准操作流程（SOP）推进：

```
[检视 Exemplar 模板]
        │ 读取 .agent/exemplars/pi/template/ 中的标准结构
        ▼
[提取规范接口与契约]
        │ 确定新工具的入参 Schema、返回格式、IO 隔离策略
        ▼
[即兴编写验证脚本]
        │ 在 code_interpreter 隔离沙盒 (.scratch/) 中试验
        ▼
[沙箱完整性验证]
        │ 确认 exitCode === 0, stdout 为无污染纯 JSON, stderr 包含日志
        ▼
[固化落盘工具脚本]
        │ file_write → <workspace>/.agent/tools/<tool_name>.py
        ▼
[配套生成标准技能卡]
        │ file_write → <workspace>/.agent/skills/<skill-name>/SKILL.md
        ▼
[索引刷新与能力就绪]
        │ skills.ts 自动发现，后续任务可直接检索复用
```

通过这一闭环，Agent 不再是只能依赖预设死功能的黑盒，而是一个能够源源不断从基因蓝本中吸收养分、持续自生自长的通用智能体。
