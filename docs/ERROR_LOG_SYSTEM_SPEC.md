# 错误日志系统规格（Error Log System Spec）

> 状态：**待实现**（本文件是契约与验收标准，生产代码由项目主人亲笔落盘）
> 范围：`apps/desktop`（Electron Main/Renderer）+ `services/agent-runtime`（Python）+ `packages/protocol`（共享契约）
> 关联约定：`AGENTS.md` §0（反孤岛）、§3（Zod ↔ Pydantic ↔ Fixtures 三步同步）、§6（门禁）

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 可验收的判据 |
|:--|:--|:--|
| G1 | 崩溃可追溯 | Electron Main 未捕获异常、Python 子进程崩溃、Renderer 渲染异常，重启后仍能在日志里查到堆栈 |
| G2 | 跨进程统一 | 同一份 `LogRecord` 形状同时容纳 main / python / renderer 三个来源 |
| G3 | 可聚合到「一类 bug」 | 同一逻辑错误即使数字/UUID/行号不同，也归入同一 `fingerprint` |
| G4 | 不泄密 | API Key、Bearer Token、密码、邮箱、手机号、用户名路径在落盘前被脱敏 |
| G5 | 可直接定位 | 每条记录带 `sessionId` + `taskId`，能把错误串回具体任务 |
| G6 | 崩溃安全 | 进程被强杀时，已 `flush` 的记录不丢；日志自身故障不拖垮主流程 |
| G7 | 可查看 | 设置页有「错误日志」面板，按类聚合、可复制诊断包 |

### 1.2 非目标（本期明确不做）

- **不做**远程上报 / 遥测服务器。日志只落本机 `userData`，导出靠用户手动复制。
- **不做**自动修 bug。不改代码、不触发 self-healing、不写 task ledger。
- **不做**行为分析。禁止记录对话正文、文件内容、模型输入输出原文；只记元数据与错误描述。
- **不做**全量性能追踪（无 tracing span、无采样火焰图）。
- **不做**日志加密。依赖磁盘权限 + 脱敏，不做静态加密。

---

## 2. 现状缺口（实测，作为设计依据）

| 缺口 | 证据 |
|:--|:--|
| 零持久化 | 全仓无 `electron-log` / `winston` / `pino` 依赖；无任何写日志文件的代码 |
| 输出即丢弃 | TS 侧 37 处 `console.*`、Python 侧 54 处 `print` / `sys.stderr.write`，打包后无控制台即丢失 |
| 无全局兜底 | 全仓无 `uncaughtException` / `unhandledRejection` / `sys.excepthook` 监听 |
| 子进程 stderr 丢失 | `runtime/python-supervisor.ts` 收到 stderr 仅 `emit('stderr', chunk)`，无消费者落盘；子进程崩溃只留 `code=… signal=…` 一行 |
| 已有错误码可复用 | `packages/protocol/schemas/errors.ts` 的 `ERROR_CODE`、`runtime/error-code.ts` 的 `RUNTIME_ERROR_CODE` |
| 目录语义冲突 | 仓库根 `logs/` 只存 `.eval` 评测产物，**不可**复用为运行日志目录 |

---

## 3. 总体架构：单写入者

文件写入者**只有 Electron Main 进程**。Python 与 Renderer 都不直接碰磁盘，避免 Windows 上多进程 append 同文件互相截断。

```
┌─────────────── Renderer (sandbox) ───────────────┐
│ window.onerror / unhandledrejection              │
│   → preload: personalAgent.reportError()          │
└───────────────────────┬──────────────────────────┘
                        │ ipcRenderer.invoke
┌───────────────────────▼──────────────────────────┐
│ Electron Main（唯一写入者）                        │
│  console-bridge ──┐                               │
│  crash-guard ─────┤                               │
│  logs-ipc ────────┼──► Logger ──► JsonlSink ──► userData/logs/*.jsonl
│  python-stderr ───┘      │                        │
│                          └──► RingBuffer ──► IPC 推送（面板实时）
└───────────────────────▲──────────────────────────┘
                        │ stderr 帧：@@PALOG@@{json}\n
┌───────────────────────┴──────────────────────────┐
│ Python runtime                                    │
│  logging handler / excepthook → StderrEmitter     │
└──────────────────────────────────────────────────┘
```

关键决策与理由：

1. **Python 走 stderr 帧而非直写文件**：`python-supervisor.ts` 已经接管 stderr，天然是全量出口；main 侧解析后统一落盘，附带 `source: "python"` 与 `taskId`。代价是 Python 崩溃在 main 已死时无法自写，此时由 main 的 crash-guard 记录 `RUNTIME_CRASHED`。
2. **帧带魔数前缀**：`@@PALOG@@` 让人类可读的 stderr（已有 54 处裸写）与结构化日志共存，非前缀行降级为 raw 记录，不丢信息。
3. **JSONL 而非 SQLite**：崩溃瞬间只需 `append` 一行即持久；SQLite 需要事务提交。聚合查询在内存里做（`groupRecords`），数据量由保留策略封顶（7 天 / 200MB）。
4. **限流在 Logger 层**：渲染循环报错会瞬间刷爆磁盘，必须按 `fingerprint` 降采样，而不是靠调用方自觉。

---

## 4. 数据契约：`LogRecord`

**单一事实来源**：`packages/protocol/schemas/logging.ts`（Zod）。
**镜像**：`services/agent-runtime/src/personal_agent/protocol/models.py` 的 `LogRecordModel`，`ConfigDict(extra="allow")`。
**交叉验证**：`packages/protocol/fixtures/logging/*.json` 被 TS 与 Python 测试共同读取。

| 字段 | 类型 | 必填 | 约束 |
|:--|:--|:--|:--|
| `schemaVersion` | `1` | ✅ | 字面量 `1`，未来破坏性变更才升 |
| `id` | string | ✅ | 非空，UUID v4 或等价唯一串 |
| `ts` | string | ✅ | ISO 8601 带毫秒与 `Z`，UTC |
| `level` | enum | ✅ | `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `source` | enum | ✅ | `main` \| `python` \| `renderer` |
| `event` | string | ✅ | 稳定点分事件名，如 `tool.call.failed`；**禁止**拼入变量 |
| `code` | string | ❌ | 复用 `ERROR_CODE` / `RUNTIME_ERROR_CODE` / 异常类名 |
| `message` | string | ✅ | 已脱敏、已截断（≤ 4096 字符） |
| `stack` | string | ❌ | 已脱敏、已截断（≤ 8192 字符） |
| `fingerprint` | string | ✅ | 40 位小写 hex（sha1） |
| `sessionId` | string | ✅ | 一次应用启动一个 |
| `taskId` | string | ❌ | 关联 `tasks` 表主键 |
| `traceId` | string | ❌ | 单次请求/工具调用链路 |
| `durationMs` | number | ❌ | ≥ 0，用于慢操作 |
| `context` | object | ❌ | 白名单外的键也接受，但值受 §8 限制 |

Zod 用 `z.looseObject(...)`：未知字段**保留**而非静默丢弃（对齐 Pydantic `extra="allow"`）。

非法取值一律拒绝：`level: "warning"`（应写 `warn`）、`schemaVersion: 2`、`fingerprint` 非 40 hex。

---

## 5. 传输契约：Python stderr 帧

```
@@PALOG@@{"schemaVersion":1,"id":"...","ts":"2026-10-19T13:29:33.123Z","level":"error","source":"python","event":"tool.execute.failed","code":"TERMINAL_EXECUTE_FAILED","message":"...","fingerprint":"...","sessionId":"...","stack":"..."}\n
```

规则：

- 一行一帧，`\n` 结尾；JSON 内部换行已由序列化器转义，**不得**产生真实换行。
- 前缀 `@@PALOG@@` 后紧跟 JSON，无空格。
- 序列化用 `ensure_ascii=False`（保留中文可读），写入失败时降级 `errors="replace"`，不得抛异常。
- 解析失败（非法 JSON / schema 不符）→ main 侧记 `level=warn, event="python.log.unparsed"`，并把原文放进 `context.raw`（截断 2KB）。
- 非前缀行 → `event="python.stderr.raw"`；以 `Traceback (most recent call last):` 开头的块 → `level=error, event="python.stderr.traceback"`，连续缩进续行合并成一条 `stack`。
- 跨 chunk 的半行必须由 parser 内部 `carry` 住，禁止截断成两条。

---

## 6. 指纹算法（TS 与 Python 必须算出同一 hex）

```
payload = `${source}|${event}|${code ?? '-'}|${normalizeMessage(message)}|${topFrame(stack) ?? '-'}`
fingerprint = sha1_hex(payload)     // utf-8，40 位小写
```

`level` **不参与**：同一逻辑错误从 warn 升级为 error 不应分裂成两组。

### 6.1 `normalizeMessage`（严格按顺序，正则用 `[0-9]` 而非 `\d`，避免 Unicode 数字差异）

1. `trim()`
2. UUID → `<uuid>`：`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`
3. 时间戳 → `<ts>`：`[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?`
4. 十六进制字面量 → `<hex>`：`0x[0-9a-fA-F]+`
5. 数字 → `<n>`：`[0-9]+(\.[0-9]+)?`
6. 连续空白 → 单个空格
7. 截断到 200 字符

### 6.2 `topFrame`

取 `stack` 中第一行匹配 `^\s*at\s+(.+)$` 的帧：

- `at fnName (path:line:col)` → `fnName@basename(path)`
- `at path:line:col` → `@basename(path)`
- 其他 → 整行压缩空白后截断 120
- 无匹配 → `null`

`basename` 同时按 `\` 与 `/` 切分（Windows 栈混用两种分隔符）。

**行号、列号必须从指纹中剔除**，否则每次改代码所有历史指纹失效。

固定期望值见 `packages/protocol/fixtures/logging/fingerprint-cases.json`，双端测试必须逐条相等。

---

## 7. 脱敏规则

按下列**固定顺序**依次替换（`redactText`）。顺序即契约：同一输入必须产出同一输出。

| 序 | 规则 | 匹配 | 替换 |
|:--|:--|:--|:--|
| 1 | 键值对 | `(api_key\|access_token\|refresh_token\|token\|password\|passwd\|secret\|authorization)[ \t]*[:=][ \t]*` 后接可选 `Bearer\|Basic\|Token` + 值（双引号串 / 单引号串 / 到空白或 `,;)}]` 为止） | 保留 `键+分隔符`，值替换为 `***` |
| 2 | Bearer | `\bBearer\s+[A-Za-z0-9._~+/=-]{8,}` | `Bearer ***` |
| 3 | 平台密钥 | `(sk\|pk)-[A-Za-z0-9_-]{16,}` | `$1-***` |
| 4 | 邮箱 | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | `<email>` |
| 5 | 手机号 | `\b1[3-9][0-9]{9}\b` | `<phone>` |
| 6 | Windows 用户目录 | `([A-Za-z]:\\Users\\)[^\\\s"']+` | `$1<user>` |
| 7 | POSIX 家目录 | `(/home/\|/Users/)[^/\s"']+` | `$1<user>` |

规则 1 必须吞掉可选的认证方案前缀，否则 `Authorization: Bearer xxx` 会把 `xxx` 漏出去（本规格的历史缺陷，见 `redaction-cases.json` case-1）。

`redactText` 必须**幂等**：`redact(redact(x)) === redact(x)`。

`context` 递归清洗：字符串走 `redactText` 并截断 512；`Error` 转 `{name, message, stack}`；深度 > 4 记 `<depth-limit>`；数组取前 50 项；循环引用记 `<circular>`；`undefined` 键丢弃；函数/Symbol 记 `<unsupported>`。

---

## 8. 体积与截断

| 项 | 上限 | 超限行为 |
|:--|:--|:--|
| `message` | 4096 字符 | 截断并追加 `…` |
| `stack` | 8192 字符 | 截断并追加 `…` |
| 单个 `context` 字符串值 | 512 字符 | 同上 |
| `context` 深度 | 4 层 | `<depth-limit>` |
| `context` 数组长度 | 50 | 截断 |
| 单条记录序列化后 | 32768 字节 | `context` 整体丢弃，保留其余字段，并加 `context: {"truncated": true}` |
| 单条 Python stderr 原始行 | 16384 字符 | 截断 |

---

## 9. 落盘方案

### 9.1 位置与命名

```
<userData>/logs/error-YYYY-MM-DD.jsonl          # 当日第 1 个分片
<userData>/logs/error-YYYY-MM-DD.1.jsonl        # 超过 maxFileBytes 切分，序号递增
```

- `YYYY-MM-DD` 取**本地日期**（用户看日志用的是本地时区）。
- 不写索引文件、不写 meta；文件名即唯一元数据。
- 仓库根的 `logs/` 与 `apps/desktop/logs/` 语义不同，禁止混用。

### 9.2 轮转与保留

| 参数 | 默认 | 行为 |
|:--|:--|:--|
| `maxFileBytes` | 10 MiB | 追加前若 `size + 本行字节 > maxFileBytes`，切到下一个序号文件。**空文件不做切分判断**：单条记录本身就超上限时仍写入空文件，避免无限轮转 |
| `retentionDays` | 7 | 启动时 `prune()`：删除日期早于 `今天 - (retentionDays - 1)` 的分片 |
| `maxTotalBytes` | 200 MiB | 仍超限时按日期升序删最旧分片，**绝不动今天** |

`prune()` 返回 `{ deleted: string[] }`，元素为被删除的**文件名**（basename），便于直接展示给用户。


### 9.3 故障降级（fail-open）

- 写失败（ENOSPC / EACCES / 文件被占用）：调用 `onError`，**不抛**、不阻塞调用方；该批记录丢弃。
- `mkdir` 失败同理。
- 日志系统任何异常都不得把主流程拖死——这是硬性要求，测试需覆盖。

### 9.4 缓冲策略

- `append()` 只入内存队列；`flush()` 同步落盘。
- `level >= error` 的记录在 `Logger` 内**立即** `flush()`。
- `debug` / `info` 由接线层节流（建议 100ms 定时或队列长度阈值 64），规格不强制定时器实现。
- `close()` 幂等，执行一次 `flush()`。

---

## 10. 分级与限流

- 默认 `minLevel = "info"`，可运行时 `setMinLevel()`。
- 低于 `minLevel`：**不构造** `LogRecord`（连指纹都不算），返回 `null`，不推订阅者。
- 环形缓冲：保留最近 `ringSize`（默认 200）条，供面板首屏与「相邻上下文」使用。
- 限流：同一 `fingerprint` 在 `windowMs`（默认 60s）内最多记录 `maxPerFingerprint`（默认 50）条；超出部分只计数不落盘；窗口结束时补发一条 `level=warn, event="log.rate_limited"`，`context.suppressed` 为被压掉的条数。该汇总记录本身不受限流。
- 订阅者抛错必须被吞掉，不影响其他订阅者与主流程。

---

## 11. 采集点清单（接线要求，反孤岛）

### 11.1 TS 侧（`apps/desktop/src/main/`）

| 采集点 | 位置 | 事件名 | 级别 |
|:--|:--|:--|:--|
| 未捕获异常 | `observability/crash-guard.ts` → `process.on('uncaughtException')` | `process.uncaught_exception` | fatal |
| 未处理 Promise | 同上 `unhandledRejection` | `process.unhandled_rejection` | error |
| 退出前 | 同上 `beforeExit` | `process.before_exit` | info |
| console 接管 | `observability/console-bridge.ts` | `console.<method>` | 原级别 |
| Python stderr | `runtime/python-supervisor.ts` 的 stderr 回调 → `PythonStderrParser` | `python.stderr.*` / 透传帧内 event | 透传 |
| 子进程崩溃 | `runtime/python-supervisor.ts` `handleCrash` | `runtime.child_crashed` | fatal |
| 运行时错误码 | `runtime/runtime-host.ts` 落 failed 分支 | `runtime.task_failed` | error |
| 工具执行失败 | `capabilities/executor.ts` 返回失败处 | `tool.call.failed` | error |
| 交付物闸口不过 | `verification/verify-deliverables.ts` | `verification.failed` | error |
| Renderer 上报 | `preload/index.ts` → IPC → main | `renderer.<kind>` | error |

### 11.2 Python 侧（`services/agent-runtime/src/personal_agent/`）

| 采集点 | 位置 | 事件名 |
|:--|:--|:--|
| 全局异常 | `observability/logging_setup.py` 的 `sys.excepthook` / `threading.excepthook` | `process.uncaught_exception` |
| 根 logger | `configure_logging()` 装 handler | 调用方 `logger.<level>` 的 message |
| ReAct 循环失败 | `conversation/loop/react_loop.py` 现有 `sys.stderr.write` 处替换为 `logger` | `loop.step_failed` |
| 工具执行失败 | `tools/` 抛出处 | `tool.execute.failed` |

接线验收：`rg "console\.(log|error|warn)" apps/desktop/src/main` 的结果必须全部经过 `console-bridge`（即 bridge 在 `main/index.ts` 启动早期安装），且 `main/index.ts` 里能看到 `installCrashGuard` / `installConsoleBridge` / `JsonlSink` / `Logger` 的构造与挂载。

---

## 12. UI 契约：设置页「错误日志」面板

只读面板，无编辑能力。

| 区域 | 内容 |
|:--|:--|
| 列表 | 按 `fingerprint` 聚合的一行：级别徽标、`event`、`message`（单行省略）、`count`、`lastTs` 相对时间 |
| 排序 | `lastTs` 倒序；同时间按 `count` 倒序 |
| 筛选 | 级别（默认 ≥ error）、来源（main/python/renderer）、时间范围（1/7/30 天） |
| 详情 | 堆栈（可折叠）、`context` JSON、`taskId` / `traceId`、相邻 5 条同 session 记录 |
| 操作 | 复制诊断包（`exportLogs` 的 bundle 文本）、打开日志目录、清空（二次确认） |
| 实时 | 新错误在顶部插入并发未读角标；断线降级为手动刷新 |

IPC 通道与返回类型见 §13.8。空态、加载态、读取失败态都必须有明确文案（读取失败展示错误码，不展示堆栈）。

---

## 13. 模块清单与接口契约（待主人实现）

> 下列为**契约**，不是实现。函数体由主人手写；本规格附带的测试网即按这些签名断言。

### 13.1 `packages/protocol/schemas/logging.ts`

```
LOG_LEVELS, LOG_SOURCES, LOG_SCHEMA_VERSION, PYTHON_LOG_PREFIX
LogLevel, LogSource, LogRecordWire
LogRecord            // z.looseObject，字段见 §4
```

必须同时在 `packages/protocol/schemas/index.ts` re-export（反孤岛）。

### 13.2 `apps/desktop/src/main/observability/log-types.ts`

```
LOG_LEVELS, LOG_SOURCES, LOG_LEVEL_RANK, LOG_SCHEMA_VERSION, LOG_LIMITS
LogLevel, LogSource, LogContext, LogRecord, LogInput
```

`LogInput`：`level` / `source` / `event` / `message` 必填；`code` / `err` / `context` / `taskId` / `traceId` / `durationMs` 可选。

### 13.3 `log-paths.ts`

```
LOG_DIR_NAME = 'logs'
resolveLogDir(userDataDir: string): string
dayKey(date: Date): string                       // 本地时区 'YYYY-MM-DD'
logFileName(day: string): string                 // `error-${day}.jsonl`
rotatedFileName(day: string, seq: number): string// `error-${day}.${seq}.jsonl`
parseLogDay(fileName: string): string | null     // 非本系统文件名或非法日期（如 2026-13-40）返回 null
```

### 13.4 `redactor.ts`

```
REDACTION_RULES: ReadonlyArray<{ id: string; pattern: RegExp; replacement: string }>
redactText(text: string): string
sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined
```

### 13.5 `log-record.ts`

```
BuildRecordDeps = { now?: () => Date; id?: () => string; sessionId: string; redact?: boolean }
normalizeMessage(message: string): string
topFrame(stack?: string): string | null
computeFingerprint(input: { source; event; code?; message; stack? }): string
buildLogRecord(input: LogInput, deps: BuildRecordDeps): LogRecord
serializeRecord(record: LogRecord): string        // 单行、无 '\n'、≤ 32KiB
```

`buildLogRecord` 的硬性行为：

1. `event` 为空或纯空白 → 抛 `Error`（消息含 `event`）。
2. `level` 不在枚举内 → 抛 `Error`（消息含 `level`）。
3. `err` 存在且 `message` 缺省 → 用 `err.message`；`stack` 取 `err.stack`。
4. `source: "python"` 时 `redact` 仍生效（不可信任子进程已脱敏）。
5. 输出字段顺序不参与契约，但 `serializeRecord` 必须是单行 JSON。

### 13.6 `jsonl-sink.ts`

```
SinkFileSystem = { mkdir(p): void; appendFile(p, data): void; readdir(p): string[]; stat(p): {size:number}; unlink(p): void }
JsonlSinkOptions = { dir; fs: SinkFileSystem; now?; maxFileBytes?; retentionDays?; maxTotalBytes?; onError? }
class JsonlSink { append(r): void; flush(): void; pathFor(day?): string; prune(): { deleted: string[] }; close(): void }
```

`fs` 必须可注入（测试用内存实现，禁止测试碰真实磁盘）。

### 13.7 其余

```
logger.ts        : class Logger { log; debug; info; warn; error; fatal; setMinLevel; recent; subscribe; flush }
console-bridge.ts: installConsoleBridge(logger, target?): () => void
crash-guard.ts   : installCrashGuard({ logger, process, exit? }): () => void
python-stderr.ts : PYTHON_LOG_PREFIX; class PythonStderrParser { push(chunk): void; flush(): void }
aggregator.ts    : LogGroup; groupRecords(records, options?): LogGroup[]
error-code.ts    : OBSERVABILITY_ERROR_CODE
logs-ipc.ts      : LOGS_CHANNELS; listLogs/groupLogs/exportLogs/clearLogs
```

### 13.8 IPC 契约

| 通道 | 入参 | 返回 |
|:--|:--|:--|
| `personal-agent:logs:list` | `{ limit?: 1..500; minLevel?: LogLevel; source?: LogSource }` | `{ ok:true; records: LogRecord[] }` \| `{ ok:false; code; message }` |
| `personal-agent:logs:groups` | `{ minLevel?: LogLevel; days?: 1..30 }` | `{ ok:true; groups: LogGroup[] }` \| 同上 |
| `personal-agent:logs:export` | `{ days?: 1..30 }` | `{ ok:true; bundle: string }` \| 同上 |
| `personal-agent:logs:clear` | — | `{ ok:true; deleted: number }` \| 同上 |
| `personal-agent:logs:open-dir` | — | `{ ok:true }` \| 同上 |

错误码：`OBSERVABILITY_INVALID_ARGUMENT` / `OBSERVABILITY_READ_FAILED` / `OBSERVABILITY_WRITE_FAILED` / `OBSERVABILITY_EXPORT_FAILED` / `OBSERVABILITY_CLEAR_FAILED`。

`list` 默认 `limit=100`，返回按 `ts` **倒序**（最新在前）；`groups` 默认 `minLevel=error, days=7`；`clear` 只删 `error-*.jsonl`，不清环形缓冲。

文件访问必须走注入端口，禁止在 IPC 层直接 `import fs`：

```
LogStore = { listFiles(): string[]; readFile(name: string): string; removeFile(name: string): void }

LogsIpcDeps = { store: LogStore; dir: string; now?: () => Date }
```

损坏的 JSONL 行必须跳过而不是让整次读取失败；只有底层 IO 出错才返回 `READ_FAILED` / `EXPORT_FAILED`。



### 13.9 Python

```
personal_agent/observability/__init__.py       : 导出下列符号
personal_agent/observability/record.py         : LOG_LEVEL_NAMES, PYTHON_LOG_PREFIX, LogRecord,
                                                 build_record(...), compute_fingerprint(...),
                                                 normalize_message(...), top_frame(...),
                                                 redact_text(...), python_level_to_log_level(levelno)
personal_agent/observability/emitter.py        : class StderrEmitter { emit(record) }
personal_agent/observability/logging_setup.py  : configure_logging(emitter, level?), install_exception_hooks(emitter)
```

`StderrEmitter(stream=None, *, session_id=None, now=None)`：`stream` 缺省为 `sys.stderr`。

`configure_logging(emitter, level=logging.INFO)`：在 root logger 装 handler，输出走 `emitter`，并过滤低于 `level` 的记录。

`install_exception_hooks(emitter) -> Callable[[], None]`：替换 `sys.excepthook` 与 `threading.excepthook`，先 emit `fatal` 记录，再委托给原钩子（**不得**吞掉原有行为），返回恢复函数。


`build_record` 签名：

```
build_record(level, event, message, *, code=None, context=None, exc=None,
             task_id=None, trace_id=None, duration_ms=None,
             session_id=None, now=None, id_factory=None) -> LogRecord
```

`exc` 接受 `BaseException` 实例或 `sys.exc_info()` 三元组；给出时 `stack` 取格式化后的 traceback，`message` 为空则回退为 `str(exc)`。
`level` 接受 §4 的五档字符串或标准库 `logging` 的级别名，最终统一落成 §4 枚举。

`LogRecord.to_wire() -> dict` 必须能被 `LogRecordModel.model_validate()` 接受，且字段集合与 §4 一致（`None` 的可选字段不出现）。

`python_level_to_log_level`：`DEBUG→debug`、`INFO→info`、`WARNING→warn`、`ERROR→error`、`CRITICAL→fatal`。

---

## 14. 测试网（本规格的交付物，已落盘）

| 文件 | 覆盖 |
|:--|:--|
| `packages/protocol/tests/logging.test.ts` | fixture 解析、非法 level/schemaVersion/fingerprint 拒绝、looseObject 保留未知字段、index re-export |
| `apps/desktop/tests/main/observability/log-paths.test.ts` | 目录解析、本地日期、三类文件名、`parseLogDay` 边界 |
| `apps/desktop/tests/main/observability/redactor.test.ts` | 11 条 fixture 逐条、幂等性、context 递归/深度/数组/循环/undefined |
| `apps/desktop/tests/main/observability/log-record.test.ts` | 必填校验、err 提取、截断、32KiB 丢弃 context、指纹 fixture 与归一化 |
| `apps/desktop/tests/main/observability/jsonl-sink.test.ts` | 追加落盘、按日分片、10MiB 轮转、保留天数、总量上限、写失败 fail-open、close 幂等 |
| `apps/desktop/tests/main/observability/logger.test.ts` | 级别过滤不构造、环形缓冲、error 立即 flush、限流降采样与汇总、订阅退订/抛错隔离 |
| `apps/desktop/tests/main/observability/console-bridge.test.ts` | 四级别映射、保留原输出、Error 取 stack、重复安装幂等、卸载还原 |
| `apps/desktop/tests/main/observability/crash-guard.test.ts` | uncaught→fatal+exit(1)、unhandledRejection→error 不 exit、beforeExit、卸载 |
| `apps/desktop/tests/main/observability/python-stderr.test.ts` | 魔数帧解析、非法 JSON 降级、raw 行分级、跨 chunk 半行、traceback 续行合并、超长截断 |
| `apps/desktop/tests/main/observability/aggregator.test.ts` | 指纹合并计数、first/last 时间、最新 message、排序、minLevel 过滤、空输入 |
| `apps/desktop/tests/main/observability/logs-ipc.test.ts` | 四个通道的入参校验与错误码、默认值、export bundle 结构、clear 只删 jsonl |
| `services/agent-runtime/tests/test_observability_record.py` | 与 TS 共享 fixture 的指纹/脱敏一致性、级别映射、截断、traceback 提取、Pydantic 镜像校验 |
| `services/agent-runtime/tests/test_observability_emitter.py` | 前缀、单行、ensure_ascii=False、非法字符降级不抛、日志级别过滤、excepthook 先记录再委托 |

运行方式：

```bash
pnpm test:pack                                          # protocol fixture
pnpm --dir apps/desktop exec vitest run tests/main/observability   # TS 测试网
pnpm test:py -- -k observability                        # Python 测试网
```

> 实现落地前这些测试是红的（模块不存在），这是 TDD 的预期状态，不是回归。

---

## 15. 验收标准

1. **崩溃留存**：主进程抛未捕获异常后强杀应用，重启读 `userData/logs/`，能找到 `process.uncaught_exception` 且带完整堆栈与 `sessionId`。
2. **Python 崩溃可读**：让 Python 子进程 `raise RuntimeError("boom")`，日志中出现 `source=python`、`level=fatal`、堆栈含 `RuntimeError: boom`，且 `taskId` 与触发任务一致。
3. **聚合正确**：同一 `event` 在 3 次不同 `taskId` 下失败，面板只显示 1 行、`count=3`。
4. **脱敏有效**：把 API Key 写进错误消息，日志文件中 `rg "sk-[A-Za-z0-9]{16,}"` 无命中。
5. **不拖垮主流程**：把日志目录设为只读后启动应用，功能正常，仅 `onError` 被调用一次。
6. **体积可控**：连续写入 100MB 日志后，目录总大小 ≤ 200MB，且今天的文件仍在。
7. **零正文泄漏**：以「把我的简历内容总结一下」跑完整任务后，`userData/logs/` 中 `rg` 不到简历正文任何一句。
8. **门禁通过**：实现完成后 `pnpm verify` 全绿。

---

## 16. 风险与取舍记录

| 风险 | 取舍 |
|:--|:--|
| main 先死时 Python 日志丢失 | 接受；该场景由 main 的 crash-guard 记 `RUNTIME_CRASHED`，不追求子进程自写 |
| 指纹过度归一导致不同 bug 合并 | 归一化只处理数字/UUID/时间/hex；`event` 与顶层帧参与计算，保持足够区分度 |
| stderr 帧与人类输出混流 | 靠 `@@PALOG@@` 前缀区分，非前缀行保留为 raw 记录，不丢弃 |
| 限流造成关键错误被压掉 | 汇总记录 `log.rate_limited` 带 `suppressed` 计数，信息不丢；`fatal` 不受限流 |
| 单文件写入成为主线程瓶颈 | 队列 + 批量 append；仅 error/fatal 立即 flush |
