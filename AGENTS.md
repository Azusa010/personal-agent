# AGENTS.md — PersonalAgent 核心约定

本文档面向 AI 编码代理与人类协作者，汇总本项目不可违反的结构性约定。
任何改动在提交前必须与这些规则一致。

---

## 0. 代码库探查：优先读 `.repowiki`

探查目录、理解代码结构时，**先看 `.repowiki`，再钻源码**，避免盲目全仓扫描。

| 位置 | 内容 |
|------|------|
| `.repowiki/zh/content/` | 按主题组织的 wiki 文档：项目概述、架构设计、API 协议、AI 运行时、数据存储、权限管理系统、桌面应用、用户界面、开发指南、部署发布、故障排除 |
| `.repowiki/knowledge/zh/` | 知识卡（含 `_index.yaml`，记录各模块与源文件的映射关系） |

### 规则

- 接到不熟悉的模块任务时，先读对应主题的 repowiki 文档建立全局认知，再定位源码细节。
- 用 `knowledge/zh/_index.yaml` 的 `scope` / `source_files` 映射反查相关文件，代替全仓 grep。
- repowiki 是生成快照，可能滞后于代码：**与源码冲突时以源码为准**，并顺带指出过期之处。
- 本文件（AGENTS.md）仍是结构性约定的最高权威，repowiki 只作导航与背景补充。

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

- Zod schemas: `packages/protocol/schemas/{envelope,filesystem,host,document,agent,systems,scheduler,errors}.ts`
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
- 全量跑约 30–50 秒（TASK-027 的 20 例 Eval E2E 占约 20 秒：每条 case 一个真 Python 子进程），
  每次改动后都应跑全量。

### Live Eval（TASK-027）

| 命令 | 跑什么 | 归属 |
|------|--------|------|
| `pnpm eval` | 20 条 Case 的 scripted 模式（确定性，真 Python + 真库 + 真闸口） | 已含在 `test:ts` 里 |
| `pnpm eval:live` | 同 20 条 Case，换成真模型 | 出手跑；要 `EVAL_LIVE=1` + `OPENAI_MODEL` + `OPENAI_API_KEY`，**不进 CI**（CON-006） |

清单 `tests/evals/cases.json` 是唯一事实来源（PDF 与剧本都由它生成），报告落在
`tests/evals/reports/`（不入库）。跑法与口径见 `tests/evals/README.md`。

### 端到端两套（TASK-028）

| 文件 | 验什么 |
|------|--------|
| `main/e2e/golden-path.test.ts` | 完整 Golden Path 20 轮：真 Python + 真批准 + 真建目录/移动 + 真 Reminder + 通知到点 |
| `main/e2e/failure-regression.test.ts` | 失败回归集：坏 PDF / 拒绝批准 / 进程被杀 / 计划外调用 / 预算耗尽 / 通知失败，各问「终态 + 授权根动没动 + 留下的码」 |

两套都在 `test:ts` 里。握手时下发几个能力决定计划几步（`planning.make_plan` 随可见能力
伸缩），交付物闸口再按计划推导要求——改能力清单时三处要一起看。

### 打包与演示（TASK-029）

| 命令 | 跑什么 |
|------|--------|
| `pnpm package:py` | PyInstaller 把 Python runtime 冻成 onedir 产物（约 33 MB，含 openai/pydantic） |
| `pnpm package:dir` | 冻结 + electron-builder `--dir` → `apps/desktop/dist/win-unpacked/PersonalAgent.exe` |
| `pnpm package:win` | 冻结 + electron-builder `--win` → NSIS 安装包 |
| `powershell -File scripts/demo/start-demo.ps1` | 备好演示素材并启动 app（`-Dev` 用开发版）；步骤见 `docs/DEMO.md` |

打包分两步、顺序不能反：`extraResources` 要把 `services/agent-runtime/dist/personal_agent/`
整份复制进 `<安装目录>/resources/agent-runtime/`；冻结产物不在时 electron-builder 只打一行
`file source doesn't exist` 日志、照样出一个少目录的包。运行时位置由 `runtime-host.ts` 的
`resolveRuntimeLaunch` 按「`PERSONAL_AGENT_RUNTIME` 覆盖 > 打包布局 > 开发布局」解析，
找不到就落 `crashed` 并带布局名与路径，不静默降级。

`runtime/packaged-runtime.test.ts` 是打包冒烟：冻结产物存在才跑（先 `pnpm package:py`，
再 `pnpm test:ts` 会多这 4 条），也在 `test:ts` 里。

---

## 6. 协作模式：核心代码留 TODO（项目陪练）

本项目按陪练模式推进：AI 负责脚手架与验收，**核心业务逻辑留给项目主人手写**。

### 分工

| 归属 | 内容 |
|------|------|
| AI 完整写出 | 协议 schema/fixtures、类型与接口、migration DDL、仓储 SQL 样板、import 与接线、UI 布局、测试的场景与数据（seed / 用例标题 / 期望行为的文字描述） |
| 留给主人填 | 见下表「五类陪练点」；核心业务逻辑本体一律留出 |

### 五类陪练点（留什么的判据）

| 维度 | 留什么 | 练什么 |
|------|--------|--------|
| **思维与算法** | 核心计算、数据转换、业务主逻辑（状态机转换表、判定/校验函数、算法段如时间解析） | 练脑子：不直接套答案，自己推实现细节 |
| **边界与异常** | 异常捕获与分流、超时降级、兜底方案、并发锁 | 练健壮性：墨菲定律意识，防止系统崩溃 |
| **工程与规范** | 日志打点、硬编码抽离（能力名、事件名、文案、i18n 语言包）、配置解耦 | 练洁癖：专业开发者的标准习惯 |
| **架构与设计** | 设计模式重构点（if-else → 策略/表驱动）、性能隐患（N+1、串行 await） | 练高手思维：系统设计眼界 |
| **验证与质量** | 单元测试的**断言**部分：AI 给场景、数据与期望行为的文字描述，`expect(...)` 由主人写 | 练闭环：写断言倒逼自己读懂 AI 写的代码 |

### 规则

- 标记统一 `// TODO(你填): ...`（Python 侧 `# TODO(你填): ...`），全仓搜索该标记即为待办清单；**填完必须删掉标记**，保证搜索不出现陈旧项。
- 每个 TODO 必须自带足够上下文：输入输出契约、不变量与边界条件、失败时的稳定错误码、对应验收测试的文件名。
- 每个 TODO 标出它属于五类里的哪一类（`TODO(你填)[思维与算法]:` 这种写法），便于按维度做集中练习。
- 断言留给主人的用例：AI 保留场景与 seed，函数调用照留（占位实现会让它红），`expect(...)` 换成 `// TODO(你填): 断言 —— 期望：<文字描述>`。**契约底线断言除外**（报告结构、fail-closed 底线、安全不变量）——那些由 AI 保留，不随陪练交出去。
- AI 不得顺手代填 TODO 范围内的核心逻辑；主人填完前相关测试允许红，填完后 `pnpm verify` 必须全绿。
- 验收流程：主人填 TODO → AI 跑 `pnpm verify` → 对照指导书该 TASK 的 Validation 列核对 → 通过后标 ✅ 并提交。
- 边界拿不准时按「这段代码错了会不会造成副作用/安全问题/契约漂移」判断：会 → 留给主人；不会 → AI 直接写完。
- **AI 写脚手架时不要给数据记录加 `readonly`**：留给主人构造/回填的类型（证据包、报告、执行记录…）字段一律可变，只读数组也别加。TS 的 `readonly` 只挡构造、不提供运行时保护，和 `shared/domain.ts` 里 `TaskRecord`/`PermissionRecord` 的既有写法也不一致；加了它等于把「先建空对象再回填」这种最直白的写法堵死。真正要约束不可变时靠约定与测试表达。

### 先例

- `product-state/tool-execution-repository.ts` 的 `ALLOWED_TRANSITIONS`：转换表由主人填写（原 TODO 标记已随填写移除），逐格一致性断言的测试由 AI 预先写好。
- `main/verification/`（TASK-026）：五类陪练点曾各留一处——取证的选择规则（思维与算法）、文件系统探测的失败收场（边界与异常）、能力名与事件名的硬编码（工程与规范）、收尾分支的重构点与串行 await（架构与设计）、两份测试文件里的逐条断言（验证与质量）。这一轮的标记已随填写移除（主人明确授权 AI 一次写完，见 ADR-0001），需要看「五类各长什么样」时翻这两个文件的 git 历史。
- `main/runtime/runtime-host.ts` 的 `resolvePackagedLaunch`（TASK-029，边界与异常）：打包布局的路径解析留一处 TODO，参数化纯函数 + 聚焦测试（`runtime-host.test.ts` 的「打包布局」用例）让红绿反馈一步到位。主人一次填对结构（args 为空、cwd 跟着 exe、layout 正确），唯一偏的是随包目录名——写成 PyInstaller 产物名 `personal-agent`，实际由 electron-builder 的 `extraResources.to: agent-runtime` 决定；测试输出直接给出期望与实际，改一处即过。验收：`pnpm verify` 全绿 + 真机走完整条演示链路。
- `main/settings/model-settings.ts` 的 `buildRuntimeEnv`（TASK-030，思维与算法）：把已保存的模型设置合成进子进程 env。契约（拷贝语义 / null 分支 / `PERSONAL_AGENT_SCRIPT` 压制 / 逐字段覆盖）与四条不变量写在函数上方注释里，11 条聚焦用例由 AI 预先写好（`model-settings.test.ts` 的 describe('buildRuntimeEnv')）。**填的经过**：主人一次填对结构与优先级，唯一差别是三个字段用真值判断 `if (settings.model)`——`'  '` 这类纯空白会被当成「设过了」注入环境，而他自己写 `PERSONAL_AGENT_SCRIPT` 分支时用的就是 `trim() !== ''`；改成 `?.trim()` 三行即过。**教训（AI 侧）**：契约里只写「空串」是规格漏洞——存储层写盘前把纯空白归一成 null，Python 侧 `os.environ.get` 拿到 `'  '` 却是真值；边界口径要写到底层语义，别停在常见写法。验收：`pnpm verify` 全绿（947 + 122 + 289）+ 界面化保存后 runtime 自动重启生效。

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
