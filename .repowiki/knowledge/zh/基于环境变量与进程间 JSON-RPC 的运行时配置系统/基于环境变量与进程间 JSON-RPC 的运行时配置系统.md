---
kind: configuration_system
name: 基于环境变量与进程间 JSON-RPC 的运行时配置系统
category: configuration_system
scope:
    - '**'
source_files:
    - apps/desktop/src/main/index.ts
    - apps/desktop/src/main/runtime/python-supervisor.ts
    - apps/desktop/src/main/capabilities/roots.ts
    - apps/desktop/src/main/runtime/timeouts.ts
    - services/agent-runtime/src/personal_agent/runtime.py
    - services/agent-runtime/pyproject.toml
    - apps/desktop/electron.vite.config.ts
    - package.json
---

## 1. 总体方案

本仓库没有集中式的配置文件（如 `config.yaml`、`.env` 文件），而是采用**纯环境变量 + 进程内默认值**的配置方式，配合 Electron Main 进程通过标准输入/输出以 JSON-RPC 协议启动并管理 Python 子进程（Agent Runtime）。配置来源按优先级分为：

- **运行期环境变量**：所有可配置项均通过 `process.env` / `os.environ` 注入。
- **代码内默认值**：每个环境变量都有明确的默认行为，未设置时走安全回退。
- **构建期常量**：超时、能力清单等由 TypeScript 常量推导（见 `timeouts.ts`）。
- **协议契约**：TS 与 Python 共享 `packages/protocol` 中的 Zod/Pydantic schema，作为跨语言配置的强约束。

## 2. 关键文件与位置

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/index.ts` | Electron Main 入口；读取 `ELECTRON_RENDERER_URL` 控制渲染器加载模式 |
| `apps/desktop/src/main/runtime/python-supervisor.ts` | 启动 Python 子进程，传递 `command/args/cwd/env`，实现 JSON-RPC 握手与请求转发 |
| `services/agent-runtime/src/personal_agent/runtime.py` | Python 运行时；从 `PERSONAL_AGENT_LOG_LEVEL`、`PERSONAL_AGENT_SCRIPT` 读取配置 |
| `apps/desktop/src/main/capabilities/roots.ts` | 定义根目录映射表 `ROOT_ENV = { downloads: 'PERSONAL_AGENT_DOWNLOADS_DIR' }`，统一解析路径 |
| `apps/desktop/src/main/runtime/timeouts.ts` | 集中导出 `HOST_TOOL_TIMEOUT_MS`、`RUN_TASK_TIMEOUT_MS` 等超时常量 |
| `services/agent-runtime/pyproject.toml` | Python 包元数据与脚本入口 `personal_agent = "personal_agent:main"` |
| `package.json`（根） | pnpm workspace 顶层脚本，统一 `dev/test/build/lint` 入口 |
| `apps/desktop/electron.vite.config.ts` | Vite alias 将 `@personal-agent/protocol` 指向共享 schema |

## 3. 架构与设计约定

### 3.1 环境变量命名规范
- 所有配置键使用 **全大写蛇形**，并以 `PERSONAL_AGENT_` 前缀区分项目空间：
  - `PERSONAL_AGENT_DOWNLOADS_DIR` — 下载目录 root（由 `roots.ts` 的 `ROOT_ENV` 白名单映射）
  - `PERSONAL_AGENT_SCRIPT` — 剧本脚本路径，Python 侧据此加载 `ScriptedModel`
  - `PERSONAL_AGENT_LOG_LEVEL` — Python 日志级别，默认 `INFO`
- 开发专用变量无项目前缀：`ELECTRON_RENDERER_URL`（Electron 官方约定）、`WRITE_PDF_FIXTURES`（测试开关）。

### 3.2 配置加载顺序与默认值策略
- **TS 侧**：`resolveRoot()` 在 `PERSONAL_AGENT_DOWNLOADS_DIR` 未设置时回退到 `homedir()/Downloads`；`index.ts` 在未设置 `ELECTRON_RENDERER_URL` 时加载本地 `renderer/index.html`。
- **Python 侧**：`resolve_model_factory()` 在未设置 `PERSONAL_AGENT_SCRIPT` 时返回 `None`，使 `run_task` 直接返回 `RUNTIME_MODEL_NOT_CONFIGURED` 错误码，而非崩溃。
- **日志**：`PERSONAL_AGENT_LOG_LEVEL` 默认 `INFO`，通过 `_setup_logging()` 在模块导入时生效。

### 3.3 进程间配置传递
- Electron Main 通过 `python-supervisor.ts` 的 `spawnFn(command, args, { cwd, env })` 启动 Python 子进程。注释明确：**不传 `env` 则继承父进程 `process.env`；传了就整份替换**，调用方需自行携带 PATH 等必要变量。
- 子进程通过 stdin/stdout 行式 JSON-RPC 通信，握手阶段由 TS 发送 `system.initialize` 并附带 `capabilities`、`client`、`protocolVersion`，Python 用 Pydantic 校验后返回 `InitializeResult`。
- 超时参数不在环境变量中暴露，而是由 `timeouts.ts` 根据 `PERMISSION_TTL_MS` 推导 `HOST_TOOL_TIMEOUT_MS` 与 `RUN_TASK_TIMEOUT_MS`，体现“配置即常量”的设计。

### 3.4 跨语言配置一致性
- 共享协议位于 `packages/protocol/schemas/`，TS 用 Zod、Python 用 Pydantic 描述同一份消息结构。
- `electron.vite.config.ts` 通过 `alias` 让 `@personal-agent/protocol` 直接指向源码，保证编译期类型一致。
- 环境变量名在 TS 与 Python 中以字面量重复声明（如 `SCRIPT_ENV = "PERSONAL_AGENT_SCRIPT"`），测试中也显式引用该常量以避免漂移。

## 4. 约定与约束

1. **新增配置必须通过环境变量注入**，禁止硬编码路径或密钥；默认值应在代码中就近声明并文档化。
2. **环境变量名必须以 `PERSONAL_AGENT_` 开头**（除第三方工具约定的如 `ELECTRON_RENDERER_URL`），避免污染宿主环境。
3. **rootId → 环境变量映射必须登记在 `ROOT_ENV` 白名单中**，未知 `rootId` 会抛错，防止任意环境变量被读取。
4. **Python 子进程的 `env` 由调用方显式传入**，若传入则完全覆盖父进程环境；若省略则继承当前 `process.env`——这是唯一允许的两种模式。
5. **超时等运行时参数以 TypeScript 常量形式集中管理**（`timeouts.ts`），不得分散在各处魔法数字。
6. **跨语言共享字段（协议版本、能力名、错误码）只存在于 `packages/protocol`**，TS 与 Python 各自通过 schema 校验，不允许各自维护副本。
7. **调试/测试开关**（如 `WRITE_PDF_FIXTURES`、`PERSONAL_AGENT_SCRIPT`）应通过环境变量启用，不应写入任何持久化配置。
8. **Python 包通过 `pyproject.toml` 的 `[project.scripts]` 暴露命令行入口**，由 uv/pip 安装后可直接以 `personal_agent` 命令启动，便于外部进程拉起。

## 5. 适用性说明

该仓库不存在传统意义上的配置文件系统（无 `.env`、`config.yaml`、`application.properties` 等），但存在一套清晰、可验证的环境变量驱动配置体系，贯穿 Electron 主进程、Python 子进程与共享协议层，因此本类别适用且证据充分。