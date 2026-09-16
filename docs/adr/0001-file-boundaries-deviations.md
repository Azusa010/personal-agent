# 实际目录结构与指导书 File Boundaries 的偏差

- 状态：已接受
- 日期：2026-09-13
- 最后修订：2026-09-16（TASK-029 收口：Windows Demo 打包、README 与演示脚本；陪练点一处待填，已知红 1 条）
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
- `main/verification/`（evidence-bundle.ts、ports.ts、verify-deliverables.ts、verify-task.ts）——TASK-026 的 DeliverableVerifier 与 Evidence Bundle。指导书把它放在 Python 侧（FILE-017 `personal_agent/verification.py`，已另行映射到 summary.py），但完成状态只有一个写入方：`tasks.updateStatus`。证据又全在 Main 侧——Product State 六张表、真实文件系统、真实 PDF——Python 既看不到也管不着（SEC-003、CON-005）。所以拆成四块：evidence-bundle 取证（只读、可重复）、ports 三个外部依赖的生产实现（PDF 页号、路径解析、存在性；测试注入假件）、verify-deliverables 判定表（纯函数，**本 TASK 的陪练点**）、verify-task 把两者串起来。`run-task.ts` 的收尾事务因此拆成两段：B1 落 Python 事件 + `verification_started` 但**不翻状态**，判定跑完再由 B2 落报告并翻终态；中间那段 running 窗口崩溃的话任务变孤儿，由启动收尸收成 failed，宁可失败也不放行未校验的 completed。
- `main/notifications/`（notification-port.ts、windows-notification.ts）——PAT-001 的 Notification Port/Adapter 边界（TASK-024）。port 是纯契约（不 import electron），唯一实现是 Windows adapter（DEP-011：Electron Notification，不引第三方框架）；测试注入假 port 与假 electron，换实现不动调用方。
- `main/scheduler/`（fire-reminder.ts、reminder-timer.ts、recover-reminders.ts）——TASK-024 的提醒触发链路。fireReminder 是 timer 到点与 notification.send 执行体两条入口共用的「发送一次并记录结果」编排（状态机翻转与 notification_sent / notification_failed 事件同事务）；reminder-timer 是进程内 setTimeout 挂表，超过 2^31-1 ms 的延迟分段重挂绕开溢出。recover-reminders 是 TASK-025 的启动恢复：扫 reminders 表按四状态分流（重挂 / 补发错过的 / 有 notification_sent 证据就只补记 fired / fired 与 failed 原样保留），判定表 `decideRecovery` 是纯函数，编排负责 firing→scheduled 回滚与时间戳。它扫的是全表而非 status='scheduled'，因为 fired/failed 也要进处置报告，`idx_reminders_due` 因此暂未被这一路径使用（demo 规模无所谓，真要按到期扫描再收窄查询）。
- `main/policy/`（execution-policy.ts、task-context.ts、risk.ts、argument-binders.ts、alignment.ts）——FILE-006 只规划了 execution-policy.ts，另外四个是同一条校验管道的组成部分，与它同生共死。
- `main/db/`（database.ts、pdf-repository.ts）——PDF 索引库与 Product Store 是两个独立 SQLite 库。索引失败不该连累任务状态，所以不共用连接与迁移。
- `main/product-state/` 里 FILE-008 之外的文件（task-repository.ts、plan-repository.ts、event-repository.ts、permission-repository.ts、timeline-projection.ts、tool-execution-repository.ts、reminder-repository.ts、migrations/0001~0007）——FILE-008 只规划了 database.ts。迁移按序号拆成独立文件而不是写进一份 schema，因为 0005 要改 tasks 的 status CHECK 约束：SQLite 只能走「事务外关外键 → 事务内重建表 → finally 开回 → foreign_key_check 兜底」，这段必须独占一个迁移。0006 建 tool_executions 表承载 TASK-021 的幂等 store，tool-execution-repository.ts 是其仓储层（insert / findByKey / transition），状态转换规则放在 Repository 层校验、与 DB CHECK 约束分离。0007 建 reminders 表（TASK-023）：task_id UNIQUE 是「同一 Task 不创建重复 Reminder」的数据库级保证；idempotency_key 不设 UNIQUE，因为 key = capability:argsHash 不含 taskId，两个任务参数恰好相同不是重复；四状态 CHECK（scheduled/firing/fired/failed）拦非法值，转换表在 reminder-repository.ts 的 Repository 层。
- `main/permission/` 里的 args-hash.ts、canonical-json.ts、expiry.ts、permission-ipc.ts——FILE-007 只规划了 permission-broker.ts。前三个是 TASK-018 的产物（参数规范化、哈希、过期投影），broker 依赖它们；permission-ipc.ts 是 IPC 边界的入参收窄与错误码映射，纯函数不 import electron，以便单测直接覆盖。
- `main/e2e/`（golden-path.test.ts）——确定性 E2E 要启真 Python 与真 SQLite，与被测单元同级放会污染单元测试的收集范围。
- `main/eval/`（case-manifest.ts、workspace.ts、observation.ts、judge.ts、metrics.ts、report.ts、run-eval.ts、paths.ts）——TASK-027 的 Live Eval Harness。指导书只规划了 FILE-021（清单 JSON），harness 本身没编 FILE 号。落在 Main 侧的理由与 TASK-026 同一条：评测要读 Product State 的六张表、真实 PDF 与真实文件系统，evidence 全在 Main；而评测跑的就是生产那条 `runTask`（含 TASK-026 的交付物闸口），把 harness 放别处等于再造一条链路，测的就不是生产路径了。内部按职责切：case-manifest 清单契约（含"坏清单必须被拒"）、workspace 物化（清单 → 临时 Downloads 根，PDF 现场生成）、observation 取证（页集合重读真实 PDF）、judge 判定表（纯函数，**本 TASK 的陪练点**）、metrics 统计口径（纯函数）、report 报告形状与写盘、run-eval 编排（每条 case 一个子进程）。scripted 与 live 两种模式共用同一份编排与判定，差别只在子进程里挂哪个 ModelGateway。
- `main/capabilities/` 里的 executor.ts、host-executor.ts、path-guard.ts、roots.ts、filesystem-list.ts、filesystem-create-dir.ts、filesystem-move.ts、pdf-fixtures.ts、idempotency.ts——Phase 1 File Boundaries 只列了 registry / scope / retriever / document-extract-pdf。filesystem-create-dir / filesystem-move 是 TASK-020 的两个 WRITE 执行体；idempotency.ts 是 TASK-021 的幂等编排层（key 计算 + 恢复 resolver + 执行前后状态翻转），由 executor.ts 在 WRITE 能力上挂载。
- `main/runtime/` 里的 runtime-host.ts、error-code.ts、timeouts.ts——FILE-005 只规划了 python-supervisor.ts。runtime-host 是私有单例的窄网关，error-code 是 IPC 侧错误码登记表，timeouts 集中推导三层超时（批准窗口 300s < host 传输层 305s < run_task 1585s），避免三个值各自硬编码后失去大小关系。
- `shared/`（domain.ts、ipc-contract.ts）——Main 与 Renderer 的共同类型归属地。Renderer 直接 import main 下的模块会把 SQLite 依赖带进渲染层。
- `preload/index.d.ts`——FILE-010 只规划了 preload/index.ts。
- `main/runtime/packaged-runtime.test.ts`、`main/runtime/runtime-host.test.ts`——TASK-029 的打包冒烟与布局解析单测。冒烟在冻结产物不存在时整块 skip（与「venv 不在就跳过」同一条规矩）；布局测试把 `resolveRuntimeLaunch` 参数化成纯函数，三分支直接喂值，不必 mock 成打包态。

仓库根与文档：

- `scripts/demo/start-demo.ps1`——TASK-029 的演示脚本（准备素材 + 启动 app）。不属于任何包，放仓库根的 `scripts/`；幂等：每次重置自己的演示根（`%TEMP%\personal-agent-demo`），不碰真实 Downloads。
- `docs/DEMO.md`——演示清单（TASK-029 交付物之一）。`docs/` 下此前只有本地维护的 DEVELOPMENT.md 与 ADR，DEMO.md 随仓库入库。
- `README.md`——TASK-029 的 setup guide（此前是空文件，模板遗留）。

Python 侧：

- `packaging/`（entrypoint.py、personal_agent.spec）——TASK-029 的冻结打包。指导书只写了「完成 Windows Demo 打包」，没规划打包脚本放哪。放 Python 侧的理由：spec 与入口都是 Python 生态的文件，离被冻结的源码最近；产物落 `services/agent-runtime/dist/`（已忽略），再由 electron-builder 的 extraResources 复制进安装包。entrypoint.py 单独一层而不是直接拿 `__main__.py`：把包内文件当脚本喂给 PyInstaller 时，Analysis 以脚本目录为基准解析 import，成败取决于构建机的 sys.path 运气。
- `host_channel.py`——反向 RPC（Python 调 Main 的工具）通道。指导书规划的是单向请求。
- `protocol/models.py`——Pydantic 镜像。指导书 §5 没有 protocol 层。
- `planning.py`——Phase 1 File Boundaries 列了，但 §5 没有对应的 FILE 编号。
- `live_model.py`——TASK-027 的真实模型适配器（DEP-012：OpenAI Responses API，模型名只从 `OPENAI_MODEL` 读）。FILE-016 `model_gateway.py` 是抽象端口，适配器是它的第二个实现（第一个是 ScriptedModel）。结构化输出用 `responses.create` + 手写 json_schema 而不是 SDK 的 `responses.parse`：parse 的 `text_format` 只收 BaseModel / dataclass（`ModelDecision` 是判别联合，进不去），且它固定 `strict=True`，而 strict 模式不收 `arguments` / `facts` 这类自由对象。schema 由 `TypeAdapter(ModelDecision).json_schema()` 派生，合同的单一事实来源仍在 model_gateway。顺带产出 `model_usage` 事件（engine 收尾时向实现了 `UsageReporting` 的网关要一次用量，插在终态事件前）：payload 走 `RunTaskEvent.payload`（`z.unknown()`），**没有改 wire schema**，字段名由 observation.test.ts 拉真 Python 读一遍钉住。

protocol 包：

- `packages/protocol/schemas/` 下的九个文件（envelope、errors、systems、filesystem、document、host、agent、scheduler、index）——FILE-018 只规划了 `schemas/` 这个目录，没规划内部按能力域拆分。scheduler.ts 是 TASK-023 加的（SchedulerCreateParams/Result/Outcome 与 ReminderStatus 枚举）。

### 指导书规划，实际不存在

- FILE-020 `tests/fixtures/pdfs/`——目录只有 `.gitkeep`，没有二进制 PDF。测试用的 PDF 由 `main/capabilities/pdf-fixtures.ts` 提供。（TASK-027 的 20 条 Eval Case 同样不落库二进制：页面文本写在 FILE-021 的清单里，跑的时候现场生成。）
- `personal_agent/tools/`——只剩一个 `__init__.py`，实现已迁到 TS 侧（见上表最后一行）。全仓无任何 import 引用它，pytest 与 ruff 都不再触及。属于可删的残留。
- ASSUMPTION-004 规划的 Reading 授权根——`RootId` 枚举与 `ROOT_ENV` 都只有 `downloads` 一项。TASK-019 补 `filesystem.create_dir` 与 `filesystem.move` 的参数绑定器时，两者的路径都只用 downloads 根校验，fixture 里的目标路径写成 `Downloads/Reading/...`，即 downloads 根下的子目录。理由：批准链路要验的是「展示完整路径 → 挂起 → 批准 → 落库」，与路径落在哪个根无关；而引入独立 Reading 根要改双端枚举并新增环境变量，它真正被用到是 TASK-020 移动文件的时候。届时两个 fixture 的目标路径要跟着改。

### 路径一致但职责有偏差

- FILE-009 `capabilities/registry.ts`——指导书要求「Capability 元数据和 executor 绑定」，实际 registry 只存元数据（name / kind / description），执行分派在 `capabilities/executor.ts` 里按 name 走。理由：多数 executor 在 Phase 1 尚未实现，绑上去只能填抛错占位。

### 一致项

FILE-001、FILE-002、FILE-005、FILE-006、FILE-007、FILE-008、FILE-010、FILE-012、FILE-014、FILE-015、FILE-016、FILE-018、FILE-019、FILE-022 与实际一致。本文件所在目录即 FILE-022。

FILE-021 `tests/evals/cases.json` 在 TASK-027 落地，路径与指导书一致：20 条 Case 的清单，
旁边的 `tests/evals/README.md`（跑法）与 `reports/`（产物，不入库）是同一个目录下的补充。
清单里的页面文本用可打印 ASCII：PDF 由 `pdf-fixtures.ts` 的 `buildPdf` 现场生成，
它按 PDF 字符串字面量写内容流，括号与反斜杠会破坏字面量、非 ASCII 在 latin1 下静默变问号；
判定用的 keywords 仍可以是中文（那是对摘要正文匹配的）。

## 后果

**正面**

- 路径决策的理由有了归处，核对 File Boundaries 不再需要重新推导。
- 工具执行集中在 Main，路径校验与授权判定在同一进程内完成，不存在跨进程的信任传递。

**负面**

- 指导书 §5 与实际结构的对照要靠本文件维护，新增目录时必须同步补一条，否则这份记录会过期成新的误导源。
- `personal_agent/tools/` 是空壳，留着会让人以为 Python 侧还有工具实现。
- ~~批准链在真实运行中仍未接通~~ **（TASK-028 已清）**：`host-executor.ts` 现在按**当前任务**现取 Scope（`agentTaskScope`：两个 READ + create_dir / move / scheduler.create，不含 notification.send——它由 Reminder 到点触发，不是模型自选动作），权限/幂等/调度三组依赖在 `index.ts` 启动时经 `configureHostExecutor` 注入；`planning.py` 的计划随可见能力伸缩（见下条）。配套的三处真实缺陷也是这一轮 E2E 逼出来的：① `permissions.tool_call_id` 是全局 UNIQUE，而 callId 只在任务内有意义——第二个任务复用 call-1 就在批准那一步崩（migration 0008 收窄成 UNIQUE(task_id, tool_call_id)，仓储的 `findByTaskAndToolCall` 与 broker/policy 的 verify 入参一并带 taskId）；② 幂等键 `capability:argsHash` 不含任务，而它是 `tool_executions` 的主键——第二个任务动同一份文件会撞主键或被别的任务的记录静默跳过（改成 `taskId:capability:argsHash`）；③ engine 的默认预算 5 次工具调用是在决策**之前**判的，完整路径要 5 次调用 + 1 次摘要决策，5 会让模型做完第五步就再也给不出摘要（抬到 8 次 / 12 步，`timeouts.ts` 的镜像与派生超时跟着走）。
- ~~TASK-025 的恢复服务「组件就位、启动路径未调用」~~ **（TASK-028 已清）**：`index.ts` 启动时建通知端口（`ElectronNotificationAdapter`）与 `ReminderTimerService`，并把 `recoverReminders` 接上（扫全表按四状态分流），失败只打日志不中断启动。提醒链路因此在真实启动路径上成立——`fireReminder` 由 timer 与恢复补发两条入口共用。
- TASK-027 的评测配置仍是**只读**，但成因变了：TASK-028 起计划按握手下发的能力伸缩（只给两个 READ → 三步计划），所以 Eval 的 20 条 Case 走的是"只读配置"，不是"还没接线"。报告里的 `scope` 已改成这个说法（「只读配置：握手只下发 …（计划因此是三步）」）。完整 Golden Path（含 move 与 Reminder）在 `e2e/golden-path.test.ts` 里验：20 轮真批准 + 真移动 + 真提醒 + 真通知到点。
- TASK-027 的真模型路径（`live_model.py`）只被假 client 验过：本机没有 API Key、也不该让 CI 出网（CON-006），所以钉住的是适配器的翻译层——请求怎么组装、`output_text` 怎么变回 `ModelDecision`、用量怎么记账、失败怎么收成 `MODEL_CALL_FAILED`。真账号跑通与否要主人出手验（`EVAL_LIVE=1 OPENAI_MODEL=… OPENAI_API_KEY=… pnpm eval:live`），这一步没做之前，`RUNTIME_MODEL_NOT_CONFIGURED` 之外的模型侧行为都还只是"合同上应当如此"。
- TASK-027 的陪练点只有一个，且是上次卡点的直接产物：`main/eval/judge.ts` 的 `judgeCase`（单条 case 判定表，思维与算法）。上一轮（TASK-026）一次铺了九个 TODO 加一份断言清单，主人先是"不会写了"、再是"写不下去了就这样吧"；这次按"一次只推一个函数 + 它自己的聚焦用例"来，其余部分（清单、物化、取证、统计、报告、编排、live 适配器）全部写完并绿。**结果**：主人自己填完并修掉了三处 `selectedTarget` 的问题（单份 PDF 时 `target` 为 null 要回落到 `targetPdf()`、能力名不是 `extract_pdf` 而是 `document.extract_pdf`、比的是 `basename` 而不是绝对路径）与一处 reasons 计数（判"这条 fact 自己没通过"而不是"已经有 fact 没通过"），AI 补齐了 judge.test.ts 的八条断言。同时补了两条本来会漏掉的东西：清单 schema 多了一条不变量（要点 `text` 必须能被自己的某个 keyword 命中——scripted 模式的 fact 正文就是这段 text，关键词不在里面等于自己造永久假阴性），以及一条"标准答案 20/20"的自检断言（清单、剧本合成、判定表三者必须一致；没有它，判定表把 20 条全判失败也只体现为报告里一个 0/20，没有任何红点）。另外把 25 条要点的关键词改成中英变体：live 模式下面向中文目标的真模型会给出中文摘要，纯英文短语（`buddy`、`stainless steel`、`30 seconds`）一个都命中不了，召回率会大面积假阴性。验收：`pnpm verify` 877 + 284 全绿，scripted 20/20 完整成功、页码引用 100%、关键结论召回 100%、四条闸口全过。
- TASK-028 的失败回归集（`e2e/failure-regression.test.ts`）把系统真的弄坏六次：坏 PDF、用户拒绝批准、Python 在 WRITE 挂起时被杀、模型第一步就计划外调用、模型一直犯错到预算耗尽、通知发送失败。每个场景问同一组问题——终态对不对、**授权根动没动**（副作用只看文件系统，不看回包）、留下的码/事件够不够排查。这组期望从用例里抽成了 `e2e/fault-expectations.ts` 的 `judgeFault`（又是一处「一次只推一个函数」的陪练点）。跑这组用例的副产品比用例本身值钱：它逼出了上面记的三处真实缺陷（UNIQUE 全局、预算只够旧路径、`stop()` 挂在已退出的进程上——最后这条会让 `before-quit` 的 `app.quit()` 永远等不到，是真的会卡住退出的 bug）。**陪练点的经过**：主人第一版把期望表**当成了违规列表**——每个场景无条件 `violations.push('<期望的描述>')`，于是连"现场完全合规"也恒判不通过（用一组构造的合规现场喂进去，六个场景全返回 `ok:false`，violations 里正是那些期望文本）。方向反了是这个函数唯一的坑：`violations` 装的是"判不通过的理由"，只有期望不成立时才推。主人授权 AI 一次改完后（helper `require_(condition, message)` 固定方向 + 三条共用底线统一判 + 六条回归断言与三条 fail-closed 底线断言），六个场景对着真链路全绿。验收：`pnpm verify` 122 + 893 + 289 全绿。
- TASK-026 的陪练点按 AGENTS.md §6 的五类切法铺开后，经主人明确授权（「你直接给 debug，然后写完吧」）由 AI 一次填完，标记清零：取证的选择规则（选哪份 PDF / 跟随移动 / 配对工具结果）、文件系统探测与 PDF 缺口的收场、能力名从 protocol 派生、端口失败留痕、串行探测并行化与收尾三态表驱动、两份测试文件里「断言待补」的用例。填完的判定表按**计划**决定要哪些交付物（计划里有 move 才要求文件与批准、有 scheduler.create 才要求 Reminder），不是照搬 Golden Path 的固定清单——否则只读计划的 20 轮 E2E 会永远红。验收：`pnpm verify` 815 条全绿，含 20 轮只读 Golden Path E2E（真判定器 + 真端口 + 真 Python）。
- TASK-029 的打包选型：**PyInstaller onedir 冻结 Agent Runtime 随包分发**，不是分发 venv（venv 里的 python.exe 是 launcher，pyvenv.cfg 记着构建机的解释器路径，换机器必失效），也不是让用户自装 Python/uv（那就不叫打包交付）。onedir 而不是 onefile：onefile 的 bootloader 每次启动解压一遍、还多一层父进程，kill 时容易留孤儿，而 TEST-015 明确要盯「退出无孤儿进程」。产物 33 MB，`package:py`（spec 在 `services/agent-runtime/packaging/`）→ `extraResources` → `<安装目录>/resources/agent-runtime/`；`resolveRuntimeLaunch` 按「env 覆盖 > 打包布局 > 开发布局」解析，找不到就落 crashed 并带布局名与路径的可读提示。冻结时显式收集 `personal_agent` 全子模块树与 `openai`（live SDK 是延迟 import，漏收的后果是「scripted 一切正常、一配真模型就崩」，很难查）。
- TASK-029 顺带统一了产品身份：`productName: PersonalAgent` 写在 apps/desktop/package.json（Electron 运行时的 `app.getName()`/userData 路径与 electron-builder 产物命名共用这一处，写两处必漂）；`appId` 与主进程的 `setAppUserModelId` 一起改成 `com.personalagent.app`（Windows 通知按 AUMID 匹配开始菜单快捷方式，不一致时开发态正常、安装版不弹）；模板继承的 mac/linux/dmg/appImage 段与 `publish`（指向 example.com 的假更新源）删除——配置写着支持而从未验证，比没有配置更误导（CON-003 本就只承诺 Windows）。**副作用：userData 从 `%APPDATA%\apps-desktop` 变为 `%APPDATA%\PersonalAgent`**，旧库不会自动迁移。
- TASK-029 的真机验收（TEST-015）跑通全链路：`pnpm package:dir` → `scripts/demo/start-demo.ps1` 启动打包版 → 发送目标 → 三次批准（create_dir / move / scheduler.create，面板每次都展示能力名、来源与目标绝对路径、参数摘要、指纹与到期时间）→ 文件真的移动 → `verification_passed` 四项全过、任务 completed → 提醒到点 `notification_sent` 且库里 `fired` → 关窗后 `PersonalAgent.exe` 与 `personal_agent.exe` 全部退出。冒烟里假地址那两条 live 用例还证明 openai SDK 确实随包可用（收成 MODEL_CALL_FAILED 而不是进程崩）。
- TASK-029 逼出并修掉两处缺陷：① Renderer 只在挂载时读一次 runtime-status，而 Main 侧从 starting 到 ready 是异步的（打包版还要先拉冻结产物），状态栏会永远停在「运行时启动中」——改成在 starting 期间每秒轮询、到终态停表；② `extraResources.from` 相对 **apps/desktop** 解析（不是仓库根），写成 `../services/...` 会指向 `apps/services/...`，而 electron-builder 只打一行 `file source doesn't exist` 日志、照样产出少一个目录的安装包——这类「静默漏拷贝」只能靠产物检查与真机启动发现。
- TASK-029 的陪练点一处：`resolvePackagedLaunch`（边界与异常，打包布局的路径解析）。AI 先用临时实现把「打包版自动发现运行时」整条链路在真机上验通（填法与期望值都在 `runtime-host.test.ts` 里钉着），再恢复成占位交付；填完前 `pnpm verify` 有且仅有这 1 条红。另外演示脚本有个使用注意点写进了 DEMO.md：剧本的 `remindAt` 是脚本运行时算死的静态时刻，三个批准要在它之前点完，否则 scheduler.create 会以 `REMINDER_TIME_IN_PAST` 失败、闸口照样判不通过（这是产品的正确行为，不是 bug）。
