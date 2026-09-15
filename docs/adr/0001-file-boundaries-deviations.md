# 实际目录结构与指导书 File Boundaries 的偏差

- 状态：已接受
- 日期：2026-09-13
- 最后修订：2026-09-15（TASK-023 完成：补记 reminder-repository、migration 0007 与 protocol 的 scheduler schema；「后果」一节的执行体现状同步到五能力）
- 对照对象：`architecture-personal-agent-v0.1.md` 的 §5 Files（FILE-001~022）与 Phase 1 File Boundaries

## 上下文

指导书 v0.1 的文件清单是在写第一行代码之前拟的。到 TASK-017 完成为止，实际结构与它有二十余处不一致。

每次开始一个 TASK 前都要核对 File Boundaries，核对结果一直是「不一致，但有理由」，而这些理由散落在对话记录和提交信息里，没有归处。下一次核对时又要重新推一遍。

## 决定

保留实际结构，不回改。

指导书 §5 与 Phase 1 File Boundaries 视为**初稿意图**，不作为路径契约。路径的唯一事实来源是仓库本身，偏差记录在本文件。

指导书里每个 TASK 的 Deliverables 与 Validation 两列仍然照原样执行，只有文件路径以实际为准。新增目录时在本文件补一条。

## 偏差清单

### 同一职责，路径不同

| 指导书 | 实际 | 原因 |
| --- | --- | --- |
| FILE-003 `apps/desktop/forge.config.ts` | `electron.vite.config.ts` + `electron-builder.yml` | 脚手架选的是 electron-vite 模板，不是 Electron Forge；打包由 electron-builder 承担 |
| FILE-004 `main/main.ts` | `main/index.ts` | electron-vite 模板的 Main 入口约定名 |
| FILE-011 `renderer/App.tsx` | `renderer/src/App.tsx` | 模板在 renderer 下多一层 `src` |
| FILE-013 `personal_agent/main.py` | `personal_agent/__main__.py` + `runtime.py` | `python -m personal_agent` 要求入口叫 `__main__.py`；进程入口与协议主循环分开 |
| FILE-017 `personal_agent/verification.py` | `personal_agent/summary.py` | SummaryVerifier 与摘要 Schema 同源，拆成两个文件会互相 import 成环 |
| Phase 1 `renderer/features/{tasks,timeline,summary}/` | `renderer/src/components/{Sidebar,MessageStream,Composer,IndexDialog,DiagnosticsDialog,PermissionDialog}.tsx` + `renderer/src/components/ui/` + `renderer/src/view-model.ts` | 组件共用同一份 view-model（把 IPC 结果映射成渲染形状）。按 feature 拆会让三个 feature 目录都去 import 第四个，比扁平放更耦合。`ui/` 是 shadcn CLI 生成的组件源码，属生成物，eslint 对这一目录关了两条规则 |
| Phase 0 规划的 Python 侧 Trusted Tool | `main/capabilities/filesystem-list.ts`、`document-extract-pdf.ts` | SEC-003 定 Main 是唯一 Permission Authority。工具在 Python 侧执行，路径校验就只能在 Python 侧做，Main 事后才看到结果。执行搬回 Main 之后，Python 只产出「想调什么」，判定与执行都留在可信侧 |

### 指导书未规划，实际新增

TS 侧：

- `main/tasks/`（run-task.ts、reconcile.ts、get-timeline.ts）——RunTask 编排同时依赖 product-state 与 runtime，放进任何一层都会产生反向依赖，所以单独成层。
- `main/policy/`（execution-policy.ts、task-context.ts、risk.ts、argument-binders.ts、alignment.ts）——FILE-006 只规划了 execution-policy.ts，另外四个是同一条校验管道的组成部分，与它同生共死。
- `main/db/`（database.ts、pdf-repository.ts）——PDF 索引库与 Product Store 是两个独立 SQLite 库。索引失败不该连累任务状态，所以不共用连接与迁移。
- `main/product-state/` 里 FILE-008 之外的文件（task-repository.ts、plan-repository.ts、event-repository.ts、permission-repository.ts、timeline-projection.ts、tool-execution-repository.ts、reminder-repository.ts、migrations/0001~0007）——FILE-008 只规划了 database.ts。迁移按序号拆成独立文件而不是写进一份 schema，因为 0005 要改 tasks 的 status CHECK 约束：SQLite 只能走「事务外关外键 → 事务内重建表 → finally 开回 → foreign_key_check 兜底」，这段必须独占一个迁移。0006 建 tool_executions 表承载 TASK-021 的幂等 store，tool-execution-repository.ts 是其仓储层（insert / findByKey / transition），状态转换规则放在 Repository 层校验、与 DB CHECK 约束分离。0007 建 reminders 表（TASK-023）：task_id UNIQUE 是「同一 Task 不创建重复 Reminder」的数据库级保证；idempotency_key 不设 UNIQUE，因为 key = capability:argsHash 不含 taskId，两个任务参数恰好相同不是重复；四状态 CHECK（scheduled/firing/fired/failed）拦非法值，转换表在 reminder-repository.ts 的 Repository 层。
- `main/permission/` 里的 args-hash.ts、canonical-json.ts、expiry.ts、permission-ipc.ts——FILE-007 只规划了 permission-broker.ts。前三个是 TASK-018 的产物（参数规范化、哈希、过期投影），broker 依赖它们；permission-ipc.ts 是 IPC 边界的入参收窄与错误码映射，纯函数不 import electron，以便单测直接覆盖。
- `main/e2e/`（golden-path.test.ts）——确定性 E2E 要启真 Python 与真 SQLite，与被测单元同级放会污染单元测试的收集范围。
- `main/capabilities/` 里的 executor.ts、host-executor.ts、path-guard.ts、roots.ts、filesystem-list.ts、filesystem-create-dir.ts、filesystem-move.ts、pdf-fixtures.ts、idempotency.ts——Phase 1 File Boundaries 只列了 registry / scope / retriever / document-extract-pdf。filesystem-create-dir / filesystem-move 是 TASK-020 的两个 WRITE 执行体；idempotency.ts 是 TASK-021 的幂等编排层（key 计算 + 恢复 resolver + 执行前后状态翻转），由 executor.ts 在 WRITE 能力上挂载。
- `main/runtime/` 里的 runtime-host.ts、error-code.ts、timeouts.ts——FILE-005 只规划了 python-supervisor.ts。runtime-host 是私有单例的窄网关，error-code 是 IPC 侧错误码登记表，timeouts 集中推导三层超时（批准窗口 300s < host 传输层 305s < run_task 1585s），避免三个值各自硬编码后失去大小关系。
- `shared/`（domain.ts、ipc-contract.ts）——Main 与 Renderer 的共同类型归属地。Renderer 直接 import main 下的模块会把 SQLite 依赖带进渲染层。
- `preload/index.d.ts`——FILE-010 只规划了 preload/index.ts。

Python 侧：

- `host_channel.py`——反向 RPC（Python 调 Main 的工具）通道。指导书规划的是单向请求。
- `protocol/models.py`——Pydantic 镜像。指导书 §5 没有 protocol 层。
- `planning.py`——Phase 1 File Boundaries 列了，但 §5 没有对应的 FILE 编号。

protocol 包：

- `packages/protocol/schemas/` 下的九个文件（envelope、errors、systems、filesystem、document、host、agent、scheduler、index）——FILE-018 只规划了 `schemas/` 这个目录，没规划内部按能力域拆分。scheduler.ts 是 TASK-023 加的（SchedulerCreateParams/Result/Outcome 与 ReminderStatus 枚举）。

### 指导书规划，实际不存在

- FILE-020 `tests/fixtures/pdfs/`——目录只有 `.gitkeep`，没有二进制 PDF。测试用的 PDF 由 `main/capabilities/pdf-fixtures.ts` 提供。
- FILE-021 `tests/evals/cases.json`——Live Eval 属 Phase 3 范围，尚未开始。
- `personal_agent/tools/`——只剩一个 `__init__.py`，实现已迁到 TS 侧（见上表最后一行）。全仓无任何 import 引用它，pytest 与 ruff 都不再触及。属于可删的残留。
- ASSUMPTION-004 规划的 Reading 授权根——`RootId` 枚举与 `ROOT_ENV` 都只有 `downloads` 一项。TASK-019 补 `filesystem.create_dir` 与 `filesystem.move` 的参数绑定器时，两者的路径都只用 downloads 根校验，fixture 里的目标路径写成 `Downloads/Reading/...`，即 downloads 根下的子目录。理由：批准链路要验的是「展示完整路径 → 挂起 → 批准 → 落库」，与路径落在哪个根无关；而引入独立 Reading 根要改双端枚举并新增环境变量，它真正被用到是 TASK-020 移动文件的时候。届时两个 fixture 的目标路径要跟着改。

### 路径一致但职责有偏差

- FILE-009 `capabilities/registry.ts`——指导书要求「Capability 元数据和 executor 绑定」，实际 registry 只存元数据（name / kind / description），执行分派在 `capabilities/executor.ts` 里按 name 走。理由：多数 executor 在 Phase 1 尚未实现，绑上去只能填抛错占位。

### 一致项

FILE-001、FILE-002、FILE-005、FILE-006、FILE-007、FILE-008、FILE-010、FILE-012、FILE-014、FILE-015、FILE-016、FILE-018、FILE-019、FILE-022 与实际一致。本文件所在目录即 FILE-022。

## 后果

**正面**

- 路径决策的理由有了归处，核对 File Boundaries 不再需要重新推导。
- 工具执行集中在 Main，路径校验与授权判定在同一进程内完成，不存在跨进程的信任传递。

**负面**

- 指导书 §5 与实际结构的对照要靠本文件维护，新增目录时必须同步补一条，否则这份记录会过期成新的误导源。
- `personal_agent/tools/` 是空壳，留着会让人以为 Python 侧还有工具实现。
- 批准链在真实运行中仍未接通，尽管组件已全部就位：`main/capabilities/executor.ts` 已有五个执行体（list / extract_pdf / create_dir / move / scheduler.create，最后一个属 TASK-023），broker、幂等关、安全矩阵也都在 TASK-022 验证过，但 `host-executor.ts` 的 `BOOTSTRAP_SCOPE` 仍是只读、不挂 permission/idempotency/scheduler wiring，`planning.py` 的计划仍固定三步全 READ。因此 PermissionDialog、诊断区权限表与 Reminder 链路在真实运行中不会被触发，只能靠单测与 e2e 组件级验证。把生产接线（WRITE scope + broker + scheduler wiring + 计划扩展）留给 TASK-028 的完整 Golden Path E2E。
