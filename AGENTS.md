# AGENTS.md — PersonalAgent 核心约定

本文档面向 AI 编码代理与人类协作者，汇总本项目不可违反的结构性约定。
任何改动在提交前必须与这些规则一致。

---

## 1. 协议双模型同步（Zod ↔ Pydantic ↔ Fixtures）

跨语言契约走 **三步同步**，缺一不可：

| 步骤 | 位置 | 职责 |
|------|------|------|
| ① Zod schema 定义 | `packages/protocol/schemas/*.ts` | 单一事实来源，定义 wire 形状 |
| ② Pydantic 镜像 | `services/agent-runtime/src/personal_agent/protocol/models.py` | 逐字段镜像 Zod，`extra="allow"` 防静默丢数据 |
| ③ Fixtures 交叉验证 | `packages/protocol/fixtures/*.json` | 共享 JSON 样本，双端各自 parse 验证一致性 |

### 规则

- **新增/修改任何协议字段时**，必须同时更新 Zod schema、Pydantic 镜像、对应 fixture。
- Pydantic 模型必须使用 `ConfigDict(extra="allow")`，禁止默认 `extra="ignore"` 静默吞掉未知字段。
- `optional` 语义注意：Zod 的 `optional` 收 `undefined` 不收 `null`；Python 侧用 `None` 默认值 + `model_dump(exclude_none=True)` 对齐线上形状。
- 测试必须覆盖 fixture 交叉验证：TS 侧 `test_protocol_fixtures.py` 和 Python 侧 `test_protocol_fixtures.py` 共享同一份 fixture 文件。

### 关键文件

- Zod schemas: `packages/protocol/schemas/{envelope,filesystem,host,document,agent,systems,errors}.ts`
- Pydantic models: `services/agent-runtime/src/personal_agent/protocol/models.py`
- Fixtures: `packages/protocol/fixtures/*.json`

---

## 2. 安全策略链（五层纵深）

每次工具调用必须经以下五层逐层校验，任一层拒绝即终止：

```
Scope → Retriever → Binder → Executor → Path-Guard
  ①         ②         ③        ④           ⑤
```

| 层 | 模块 | 职责 |
|----|------|------|
| ① Scope | `capabilities/scope.ts` | 定义任务级权限边界（`TaskScope`），决定哪些能力对当前任务可见 |
| ② Retriever | `capabilities/retriever.ts` | 从 `CapabilityRegistry` 检索能力描述符，校验能力已注册且在 Scope 内 |
| ③ Binder | `policy/argument-binders.ts` | 用 Zod `safeParse` 校验参数契约，调用 `resolveWithinRootReal` 做路径规范化与 root guard |
| ④ Executor | `capabilities/executor.ts` | 组装 policy → 调用 `policy.evaluate()` → 分发到具体能力实现 |
| ⑤ Path-Guard | `capabilities/path-guard.ts` | `resolveWithinRootReal` 处理 6 类边界：不存在、junction/symlink、UNC 路径、根不可用、链接逃逸、大小写 |

### 规则

- 安全校验函数的入参必须用 `string` 类型，不可用枚举或 branded type——调用点传入的值不可信。
- `resolveWithinRoot` 只做字符串运算；涉及 symlink/junction 必须再经 `resolveWithinRootReal` 做 realpath 二次校验。
- 执行体（executor）拿到 binder 输出的 `paths` 后直接使用，不再二次 parse/resolve。

---

## 3. Monorepo 依赖方向约束

本仓库是 pnpm workspace monorepo，三根目录的依赖方向严格单向：

```
apps/desktop ──→ packages/protocol ←── services/agent-runtime
   (Electron)      (共享契约)          (Python runtime)
```

| 方向 | 允许 | 禁止 |
|------|------|------|
| `apps/desktop` → `packages/protocol` | ✅ 通过 `@personal-agent/protocol` 导入 Zod schema 与类型 | — |
| `services/agent-runtime` → `packages/protocol` | ✅ 通过 Pydantic 镜像对齐 fixture | ❌ 不可直接 import TS 代码 |
| `packages/protocol` → 任意 | — | ❌ 不可依赖 apps 或 services 的任何模块 |
| `apps/desktop` ↔ `services/agent-runtime` | — | ❌ 不可直接互相 import；跨进程通信只走 stdio NDJSON JSON-RPC |

### 规则

- `packages/protocol` 是纯契约包，唯一运行时依赖是 `zod`。
- `apps/desktop` 通过 tsconfig paths alias `@personal-agent/protocol` 引用。
- `services/agent-runtime` 是独立 Python 包，与 TS 侧通过 `packages/protocol/fixtures/*.json` 共享验证样本，但不共享代码。
- 新增跨包类型必须先在 `packages/protocol` 定义，再由消费方各自适配。

---

## 4. 状态机与数据库 CHECK 约束分离

状态流转逻辑与数据库约束各有边界，不可混淆：

| 关注点 | 归属 | 实现位置 |
|--------|------|----------|
| **合法值集合** | DB CHECK 约束 | SQL `CHECK (status IN (...))` |
| **合法转换规则** | Repository 层 | 转换表校验（如 `pending → running`） |
| **状态枚举定义** | TS `readonly const` 数组 | `shared/domain.ts` 中的 `TASK_STATUSES` |
| **类型派生** | TS 类型系统 | `typeof TASK_STATUSES[number]`，禁止手写联合类型 |

### 规则

- **CHECK 约束只拦截非法值，不拦截非法转换。** 状态转换规则（如哪些状态可以转到哪些状态）必须实现在 Repository 层。
- TS 侧状态集合用 `readonly const` 数组定义，类型从数组派生，保证单一事实来源。
- 测试中必须遍历状态数组做真库插入，确保 SQL CHECK 与 TS 定义同步（防漂移）。
- Persistence 层抛出领域专用错误（如 `IllegalTaskTransition`），不依赖 Runtime 侧重型模块。
- Service 层捕获领域错误后映射为全局 `RUNTIME_ERROR_CODE`。

---

## 5. 验证命令：`pnpm verify`

所有改动提交前必须通过 `pnpm verify`，它是一条命令跑完全部门禁：

```
pnpm verify = typecheck + lint:ts + lint:py + test
            = typecheck + lint:ts + lint:py + test:pack + test:ts + test:py
```

| 门禁项 | 命令 | 覆盖范围 |
|--------|------|----------|
| typecheck | `pnpm --dir apps/desktop typecheck` | TS 类型检查（node + web 两侧） |
| lint:ts | `pnpm --dir apps/desktop lint` | ESLint（含 prettier 规则） |
| lint:py | `uv run --project services/agent-runtime --locked ruff check .` | Python lint |
| test:pack | `pnpm --dir packages/protocol test` | Protocol 包 vitest |
| test:ts | `pnpm --dir apps/desktop test` | Desktop vitest |
| test:py | `uv run --project services/agent-runtime --locked pytest` | Python pytest |

### 规则

- `test:pack` 容易漏跑——protocol 包不在 `node_modules` 里，靠 tsconfig paths + vitest alias 解析。
- 新建测试文件后必须 `prettier --write` 转 LF，否则 eslint 报 CRLF warning（Windows 环境）。
- `pnpm verify:all` = `verify` + `build`（electron-vite build，不含 electron-builder 打包）。
- 全量跑约 20–30 秒，每次改动后都应跑全量。

---

## 附：架构分层速查

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
