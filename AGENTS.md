# AGENTS.md — PersonalAgent 核心约定与系统架构指南

本文档面向人类协作者与 AI 辅助代理，汇总本项目不可违反的最高结构性约定与演进规范。
任何改动在提交前必须与这些规则严格一致。

---

## 0. 核心定位与设计范式：个人智能体（Dots / Grok / Claude Code / Codex / Pi 范式）

目标形态：由单纯的本地 Coding 辅助工具演进为具备伴随感、主动性、长期记忆与角色化人格的个人全能智能体（Personal Agent）。

### 设计参考与范式融合

每次进行行动之前必须进行搜索（Search）和分析（Analyze）相对应的参考对象再进行行动。

#### 最高前置准则：一定要善用网络搜索（Web Search First）

**在进行任何架构设计、技术选型、参考标杆调研、上下文机制演进或疑难排查之前，AI 代理必须善用并主动发起网络搜索！**
1. **禁止闭门造车与凭空臆测**：模型的训练权重存在时效限制与记忆模糊，面对现代智能体前沿实践（如 OpenAI Dots 长期记忆与压缩流、Grok/Muse 伴侣架构、Claude Code / Codex 桌面端上下文压缩与状态账本机制、Pi Agent 伴侣心智等），严禁单凭固有权重经验推演，必须善用网络搜索（`search_web`）检索一手官方技术博文、开源实现论文、架构解析与行业最佳实践。
2. **前沿输入驱动方案**：通过网络搜索充分获取最新、最真实的工业级设计思路，对比分析关键技术权衡后，再形成本项目的系统规格与测试网。

| 参照标杆                                   | 核心设计范式与借鉴点                             |
|:-------------------------------------- |:-------------------------------------- |
| **Dots(OpenAI) / Grok Bot/Muse(Meta)** | **个人智能体设计**的参考                         |
| **Pi agents**                          | **用于补充Claude Code和Codex无法找到相应参考或解决方案** |
| **Claude Code / Codex 桌面端**            | **Coding agent**部分的参考                  |

---

## 0. 接线与反孤岛规则 (Anti-Orphan & Wiring Rule)
1. 严禁产生“代码孤岛”：每当你新建一个模块、组件、工具函数、状态存储（Store）或接口时，必须同步修改它的上游调用方（如父组件挂载、路由注册、主入口导出或事件总线绑定）。
2. 逆向开发顺序：涉及多文件修改时，优先或同步规划“调用处/入口文件”的变更，不要只写完底层实现就停止。
3. 交付前自检：在结束当前任务前，必须显式检查并回答：“我新写的逻辑已经在哪个文件的哪一行被实际引入并调用了？”如果尚未挂载，必须立即补全接线代码。

## 1. 协作模式：AI 可直接编写生产代码，但必须自带测试网与自检

本项目允许 AI 代理直接落盘生产代码（含 Schema、类型、DDL、SQL、接线、UI 布局、业务逻辑）。「能写」不等于「随便写」，每次写代码都必须满足以下硬性要求：

1. **先调研再动手**：动手前必须善用网络搜索，确认业内顶级实践与参考标杆，避免凭权重经验闭门造车。
2. **先讲清「要做什么」**：动手前先说明目标文件、业务职责、接口契约与验收标准，再落盘实现。
3. **实现与测试同批交付**：同一批改动必须带上 100% 完整闭环的测试套件（含场景、mock 数据、调用与全部断言，严禁留下断言 TODO），红绿反馈一步到位。
4. **接线自检**：遵守第 0 节反孤岛规则，新模块必须有实际调用方，交付前显式回答「新逻辑在哪个文件哪一行被引入并调用」。
5. **门禁自证（分层验证）**：按第 6 节分层规则跑**定向**门禁（L1/L2），全量 `pnpm verify` 只留给提交前、跨包/协议改动与发版节点——**严禁改一次就跑全量**；如实汇报「跑了什么、失败什么」，不得把未跑的全量说成已验证。

### 分工边界

| 归属        | 内容与职责                                                                                                                                           |
|:--------- |:----------------------------------------------------------------------------------------------------------------------------------------------- |
| **项目主人**  | 提出需求与验收方向、决定架构取向与关键权衡、对 AI 产出做最终 Review 与合入决定。                                                                                                       |
| **AI 代理** | **可编写生产代码、需求规格与测试网**：<br>1. **前置调研与善用网络搜索**：实现前必须善用网络搜索调研业内顶级实践与参考标杆，确保技术决策先进且切合实际；<br>2. **规格先行**：阐明目标文件、业务职责、接口契约与验收标准；<br>3. **实现与测试同交**：生产代码必须配套完整测试套件（含场景、mock 数据、调用与全部断言，严禁留断言 TODO）；<br>4. **严格自测与自查**：按第 6 节分层跑定向测试与 Lint，严查边界漏洞、状态泄漏与安全逃逸；全量 `pnpm verify` 仅在提交前、跨包改动与发版时执行。 |

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

**默认分层验证：禁止「改一次就跑全量」。** 单个文件、单个功能的微改动只跑定向门禁；全量 `pnpm verify` 只在「提交前」「跨包/协议改动」「项目主人显式要求」三类场景执行。所有改动**提交前**仍必须通过 `pnpm verify`：

```bash
pnpm verify = typecheck + lint:ts + lint:py + test
            = typecheck + lint:ts + lint:py + test:pack + test:ts + test:py
```

### 分层验证（开发期默认路径）

| 层级    | 触发场景                                | 最小命令                                                          | 明确禁止                       |
|:----- |:---------------------------------- |:------------------------------------------------------------ |:-------------------------- |
| L1 单点 | 改 1-2 个文件（纯组件、纯函数、样式、文案）          | `npx vitest run <改动对应的测试文件>`，并对改动文件单独跑 `npx eslint <file>`   | 禁止跑 `pnpm verify` / `pnpm test` |
| L2 局部 | 改动集中在单侧单包（仅 renderer、仅 main、仅 Python） | 该侧测试目录（如 `npx vitest run tests/renderer`）+ `pnpm typecheck` | 禁止顺手跑另一端的全量测试              |
| L3 全量 | 提交前、跨包/协议改动、发版前、主人显式要求            | `pnpm verify`；发版再加 `pnpm verify:all`                          | 禁止在 L1/L2 场景提前触发           |

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

- **全量门禁只在交付节点跑**：`pnpm verify` 的唯一默认触发点是「提交前」与「发版前」。开发迭代过程中严禁每改一处就跑一次全量（单次 30-50s 且会 spawn 真 Python 子进程，反复触发只会拖垮节奏）。
- **强制升级到 L3 的硬条件**：改动一旦落到 `packages/protocol`（schema / 字段 / fixture）、`apps/desktop` 与 `services/agent-runtime` 的跨端契约、`pnpm-lock.yaml` 或构建配置，必须直接跑 `pnpm verify`，不得停在定向验证。
- **定向通过 ≠ 全量通过**：只跑了 L1/L2 时，汇报必须写明「全量 `pnpm verify` 未跑（原因：…）」；严禁把定向绿灯表述成整体绿灯。
- `test:pack` 必须跑通：Protocol 包纯契约包，容易漏跑（该条在 L3 执行时生效）。
- 换行符统一 LF：Windows 环境新建/编辑文件需保持 LF，防止 ESLint 报 CRLF warning。
- 打包依赖严格时序：必须先 `pnpm package:py`，产物才会被 electron-builder 复制进 `resources/agent-runtime/`。

---

## 7. 交接文档规范（严格按需读写）

为了确保多会话、长周期演进中的工程连续性，本项目支持在 `docs/handover/` 维护交接文档。

### 核心约束

- **严格按需触发（严禁自发读写）**：
  **AI 代理严禁在常规开发或任务前后自行创建、修改或扫描交接文档！**
  **只有当项目主人明确发出要求（例如指令中明确包含「写交接文档」、「读交接文档」）时，才可执行交接文档的读取或编写。**
- **存储路径**：`docs/handover/`
- **文件命名契约**：
  - 必须统一以 **UTC+8 时间** 开头（格式 `YYYYMMDD_HHmm_` 或 `YYYYMMDD_`）。
  - 后续紧跟 **不超过 10 个字** 的文档简述。
  - 示例：`20261014_1120_智能体角色与UI改造.md`（简述部分「智能体角色与UI改造」共 9 字，未超过 10 个字）。
- **编写要点**：
  1. 任务背景与核心业务目标；
  2. 交付物清单（涉及的协议、后端存储、Preload、前端组件）；
  3. 核心设计决策与避坑记录；
  4. 当前验证状态与门禁指标；
  5. 下一阶段待办（如 Phase 2、未完成模块与遗留项等）。
- **读取要点**：
  当用户明确要求读取交接文档时，按时间倒序找到 `docs/handover/` 下最新的一份交接文档进行研读，提取关键上下文并向主人汇报现状与待办。

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
