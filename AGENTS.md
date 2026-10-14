# AGENTS.md — PersonalAgent 核心约定与系统架构指南

本文档面向人类协作者与 AI 辅助代理，汇总本项目不可违反的最高结构性约定与演进规范。
任何改动在提交前必须与这些规则严格一致。

---

## 0. 核心定位与设计范式：个人智能体（Dots / Grok / Claude Code / Codex / Pi 范式）

目标形态：由单纯的本地 Coding 辅助工具演进为具备伴随感、主动性、长期记忆与角色化人格的个人全能智能体（Personal Agent）。

### 设计参考与范式融合

每次进行行动之前必须 进行搜索(Search)和分析(Analyze) 相对于的参考对象再进行行动

| 参照标杆                                   | 核心设计范式与借鉴点                             |
|:-------------------------------------- |:-------------------------------------- |
| **Dots(OpenAI) / Grok Bot/Muse(Meta)** | **个人智能体设计**的参考                         |
| **Pi agents**                          | **用于补充Claude Code和Codex无法找到相应参考或解决方案** |
| **Claude Code / Codex 桌面端**            | **Coding agent**部分的参考                  |

---

## 1. 协作模式：生产代码全由主人手写，AI 仅出规格与测试、不做示例、只做 Review

本项目严格实行「AI 筑网验收，主人亲笔实操」：
**除测试代码与需求规格外，本工作区的所有代码编写（Schema、类型、DDL、SQL、接线、UI 布局、业务逻辑）全部由项目主人手写！AI 严禁代写任何生产代码，且在回复中禁止输出任何生产代码的示例/模板代码，只需清晰说明「要做什么」，由主人亲自构思与编写！**

### 分工边界

| 归属        | 内容与职责                                                                                                                                           |
|:--------- |:----------------------------------------------------------------------------------------------------------------------------------------------- |
| **项目主人**  | **手写所有生产代码**：协议 Schema、TypeScript 类型、Migration DDL、仓储 SQL、依赖注入接线、UI 组件布局、核心计算、业务逻辑、状态机转换表与边界异常分流全部由主人亲手落盘。                                      |
| **AI 代理** | **只写测试与规格，不做代码示例，只做 Review**：<br>1. **明确「要做什么」**：阐明目标文件、业务职责、接口契约与验收标准，不贴出任何生产实现代码或示例代码；<br>2. **编写测试网**：编写 100% 完整闭环的测试套件（含场景、mock 数据、调用与全部断言，严禁给主人留断言 TODO）；<br>3. **严格 Code Review**：主人手写完成后进行严格代码审查、执行 `pnpm verify` 跑测、严查边界漏洞、状态泄漏与安全逃逸。 |

### 核心避坑要点（历史沉淀）

- **纯函数优先**：涉及算法、裁切或环境生成的逻辑抽象为纯函数，配齐独立聚焦测试，红绿反馈一步到位。
- **一次一个焦点**：聚焦单点高价值逻辑，避免分散打乱开发心智。
- **跨语言空值边界**：TS 与 Python 交互注意纯空白字符串 `trim()`、`null` 与 `None` 语义对齐，防止环境注入误判。
- **分阶段处理**：裁剪与流转逻辑遵循「先收集预算再修整边界」的双阶段设计，避免单循环混杂导致脏数据。

---

## 2. 安全策略链（五层纵深）

每次工具调用必须经以下五层逐层校验，任一层拒绝即终止：

```
Scope → Retriever → Binder → Executor → Path-Guard
  ①         ②         ③        ④           ⑤
```

| 层            | 模块                           | 职责                                                                         |
| ------------ | ---------------------------- | -------------------------------------------------------------------------- |
| ① Scope      | `capabilities/scope.ts`      | 定义任务级权限边界（`TaskScope`），决定哪些能力对当前任务可见                                       |
| ② Retriever  | `capabilities/retriever.ts`  | 从 `CapabilityRegistry` 检索能力描述符，校验能力已注册且在 Scope 内                           |
| ③ Binder     | `policy/argument-binders.ts` | 用 Zod `safeParse` 校验参数契约，调用 `resolveWithinRootReal` 做路径规范化与 root guard     |
| ④ Executor   | `capabilities/executor.ts`   | 组装 policy → 调用 `policy.evaluate()` → 分发到具体能力实现                             |
| ⑤ Path-Guard | `capabilities/path-guard.ts` | `resolveWithinRootReal` 处理 6 类边界：不存在、junction/symlink、UNC 路径、根不可用、链接逃逸、大小写 |

### 规则

- **自描述插件架构（CapabilityPlugin）**：所有能力实现收敛在 `capabilities/plugins/`，高内聚包含 `schema`、`bind` 路径提取、`risk` 等级、`idempotency` 策略与 `execute` 执行体。严禁在 `argument-binders.ts`、`executor.ts`、`idempotency.ts` 中写硬编码的 `switch-case`。
- **动态 Scope 与单一事实来源**：`AGENT_TASK_CAPABILITIES` 动态从 `listCapabilities()` 派生，自动包含所有注册的非内部插件，严禁在 `scope.ts` 手写静态白名单；Python 侧由 `tool_schema_generator.py` 动态反射生成 OpenAI Tool Schemas，严禁手写冗余字典。
- 安全校验函数的入参必须用 `string` 类型，不可用枚举或 branded type——调用点传入的值不可信。
- `resolveWithinRoot` 只做字符串运算；涉及 symlink/junction 必须再经 `resolveWithinRootReal` 做 realpath 二次校验。
- 执行体（executor）拿到 binder 输出的 `paths` 后直接使用，不再二次 parse/resolve。

---

## 3. 协议双模型同步（Zod ↔ Pydantic ↔ Fixtures）

跨语言契约走 **三步同步**，缺一不可：

| 步骤              | 位置                                                             | 职责                               |
| --------------- | -------------------------------------------------------------- | -------------------------------- |
| ① Zod schema 定义 | `packages/protocol/schemas/*.ts`                               | 单一事实来源，定义 wire 形状                |
| ② Pydantic 镜像   | `services/agent-runtime/src/personal_agent/protocol/models.py` | 逐字段镜像 Zod，`extra="allow"` 防静默丢数据 |
| ③ Fixtures 交叉验证 | `packages/protocol/fixtures/*.json`                            | 共享 JSON 样本，双端各自 parse 验证一致性      |

### 规则

- **新增/修改任何协议字段时**，必须同时更新 Zod schema、Pydantic 镜像、对应 fixture。
- Pydantic 模型必须使用 `ConfigDict(extra="allow")`，禁止默认 `extra="ignore"` 静默吞掉未知字段。
- `optional` 语义注意：Zod 的 `optional` 收 `undefined` 不收 `null`；Python 侧用 `None` 默认值 + `model_dump(exclude_none=True)` 对齐线上形状。
- 测试必须覆盖 fixture 交叉验证：TS 侧 `test_protocol_fixtures.py` 和 Python 侧 `test_protocol_fixtures.py` 共享同一份 fixture 文件。

### 关键文件

- Zod schemas: `packages/protocol/schemas/{envelope,filesystem,host,document,agent,systems,scheduler,errors}.ts`
- Pydantic models: `services/agent-runtime/src/personal_agent/protocol/models.py`
- Fixtures: `packages/protocol/fixtures/*.json`

---

## 4. Monorepo 依赖方向约束

本仓库是 pnpm workspace monorepo，三根目录的依赖方向严格单向：

```
apps/desktop ──→ packages/protocol ←── services/agent-runtime
   (Electron)      (共享契约)          (Python runtime)
```

| 方向                                             | 允许                                                | 禁止                                            |
| ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `apps/desktop` → `packages/protocol`           | ✅ 通过 `@personal-agent/protocol` 导入 Zod schema 与类型 | —                                             |
| `services/agent-runtime` → `packages/protocol` | ✅ 通过 Pydantic 镜像对齐 fixture                        | ❌ 不可直接 import TS 代码                           |
| `packages/protocol` → 任意                       | —                                                 | ❌ 不可依赖 apps 或 services 的任何模块                  |
| `apps/desktop` ↔ `services/agent-runtime`      | —                                                 | ❌ 不可直接互相 import；跨进程通信只走 stdio NDJSON JSON-RPC |

### 规则

- `packages/protocol` 是纯契约包，唯一运行时依赖是 `zod`。
- `apps/desktop` 通过 tsconfig paths alias `@personal-agent/protocol` 引用。
- `services/agent-runtime` 是独立 Python 包，与 TS 侧通过 `packages/protocol/fixtures/*.json` 共享验证样本，但不共享代码。
- 新增跨包类型必须先在 `packages/protocol` 定义，再由消费方各自适配。

---

## 5. 状态机与数据库 CHECK 约束分离

状态流转逻辑与数据库约束各有边界，不可混淆：

| 关注点        | 归属                     | 实现位置                                    |
| ---------- | ---------------------- | --------------------------------------- |
| **合法值集合**  | DB CHECK 约束            | SQL `CHECK (status IN (...))`           |
| **合法转换规则** | Repository 层           | 转换表校验（如 `pending → running`）            |
| **状态枚举定义** | TS `readonly const` 数组 | `shared/domain.ts` 中的 `TASK_STATUSES`   |
| **类型派生**   | TS 类型系统                | `typeof TASK_STATUSES[number]`，禁止手写联合类型 |

### 规则

- **CHECK 约束只拦截非法值，不拦截非法转换。** 状态转换规则（如哪些状态可以转到哪些状态）必须实现在 Repository 层。
- TS 侧状态集合用 `readonly const` 数组定义，类型从数组派生，保证单一事实来源。
- 测试中必须遍历状态数组做真库插入，确保 SQL CHECK 与 TS 定义同步（防漂移）。
- Persistence 层抛出领域专用错误（如 `IllegalTaskTransition`），不依赖 Runtime 侧重型模块。
- Service 层捕获领域错误后映射为全局 `RUNTIME_ERROR_CODE`。

---

## 6. 验证与门禁命令

所有改动提交前必须通过 `pnpm verify`：

```bash
pnpm verify = typecheck + lint:ts + lint:py + test
            = typecheck + lint:ts + lint:py + test:pack + test:ts + test:py
```

### 命令矩阵

| 命令                                 | 职责 / 范围                                                | 运行场景             |
|:---------------------------------- |:------------------------------------------------------ |:---------------- |
| `pnpm verify`                      | 全部门禁：TS 类型 + 双端 Lint + Protocol/Desktop/Pytest 单元与集成测试 | 提交前必跑（~30-50s）   |
| `pnpm verify:all`                  | `verify` + `build` (electron-vite build)               | 发版前全量构建检验        |
| `pnpm eval`                        | 20 条标准评测 Case（确定性，真 Python + 真库 + 真闸口）                 | 已包含在 `test:ts` 中 |
| `pnpm eval:live`                   | 20 条 Case 真模型跑测（需 `EVAL_LIVE=1` 与 API Key，不进 CI）       | 离线人工打分           |
| `pnpm package:py`                  | PyInstaller 将 Python runtime 冻结为 onedir 产物             | 打包前置必备步          |
| `pnpm package:dir` / `package:win` | 构建免安装目录产物 / NSIS 安装包（依赖先跑 `package:py`）                | 桌面端打包构建          |
| `pnpm check:islands` / `:strict`   | 全栈孤岛与死代码体检（Knip 扫 TS 未用导出 + Vulture 扫 Python 死代码）      | 发版/审查按需运行        |

### 门禁规则

- `test:pack` 必须跑通：Protocol 包纯契约包，容易漏跑。
- 换行符统一 LF：Windows 环境新建/编辑文件需保持 LF，防止 ESLint 报 CRLF warning。
- 打包依赖严格时序：必须先 `pnpm package:py`，产物才会被 electron-builder 复制进 `resources/agent-runtime/`。

---

## 附：代码库探查与分层速查

### 代码库探查：优先读 `.repowiki`

- 探查目录、理解代码结构时，**先看 `.repowiki`，再钻源码**，避免盲目全仓扫描。
- 用 `.repowiki/knowledge/zh/_index.yaml` 的 `scope` / `source_files` 映射反查相关文件。
- repowiki 与源码冲突时以源码为准；本文件（AGENTS.md）是结构性约定的最高权威。

### 架构分层速查

```
Renderer (sandbox, contextIsolation)
    ↓ ipcRenderer.invoke (personal-agent:* 通道)
Preload (contextBridge 白名单)
    ↓
Main (Node, 唯一可信运行时)
    ↓ spawn + stdio NDJSON JSON-RPC
Python 子进程 (personal_agent)
```

- 工具实现分两层：Slice 2a（纯业务逻辑，无 JSON-RPC）+ Slice 2b（协议接线）。
- 2a 不 import runtime/supervisor；2b 不包含业务逻辑。
