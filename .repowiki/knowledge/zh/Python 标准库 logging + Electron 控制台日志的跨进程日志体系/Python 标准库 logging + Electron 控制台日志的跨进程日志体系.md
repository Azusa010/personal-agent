---
kind: logging_system
name: Python 标准库 logging + Electron 控制台日志的跨进程日志体系
category: logging_system
scope:
    - '**'
source_files:
    - services/agent-runtime/src/personal_agent/runtime.py
    - services/agent-runtime/src/personal_agent/engine.py
    - services/agent-runtime/src/personal_agent/host_channel.py
---

## 1. 使用的系统与框架

- **Python 侧**：使用 Python 标准库 `logging`，无第三方日志框架。所有模块通过 `logging.getLogger("personal_agent")` 获取同名 logger。
- **Electron/Node 侧（apps/desktop）**：未发现引入任何日志框架；代码中未出现 `console.log`、`debugger`、`pino`、`winston` 等调用，说明桌面端当前不主动输出结构化日志。
- **协议包（packages/protocol）**：纯类型与 JSON Schema 定义，不包含运行时日志逻辑。

## 2. 关键文件

- `services/agent-runtime/src/personal_agent/runtime.py`：集中初始化日志（`_setup_logging`），创建全局 `log` 单例，并暴露给其他模块复用。
- `services/agent-runtime/src/personal_agent/engine.py`：通过 `logging.getLogger("personal_agent")` 获取 logger，用于记录能力注册异常等警告。
- `services/agent-runtime/src/personal_agent/host_channel.py`：同样使用 `personal_agent` logger，记录通道相关事件。
- `services/agent-runtime/src/personal_agent/runtime.py` 中的 `write()` 函数：将 JSON-RPC 响应写入 `sys.stdout`，这是 Agent Runtime 与 Host（Electron main）之间的**结构化消息通道**，不属于传统“日志”，但属于进程间输出的一部分。

## 3. 架构与约定

### 3.1 Logger 命名空间
所有 Python 模块统一使用 `logging.getLogger("personal_agent")` 获取同一个命名空间的 logger，便于按名称过滤或路由。

### 3.2 级别控制
日志级别由环境变量 `PERSONAL_AGENT_LOG_LEVEL` 决定，默认值为 `INFO`。该值在 `_setup_logging` 中被 `os.environ.get(...).upper()` 后传入 `logger.setLevel`。

### 3.3 输出目标与格式
- 唯一 handler 是 `logging.StreamHandler(sys.stderr)`，即所有日志输出到标准错误流。
- 格式化器为 `"%(asctime)s %(levelname)s %(name)s: %(message)s"`，产生类似 `2024-xx-xx HH:MM:SS,mmm INFO personal_agent: runtime started` 的行式文本。
- `logger.propagate = False`，避免重复输出到 root logger。

### 3.4 结构化输出（业务事件）
Agent Engine 通过 `RunTaskEvent` 模型以 JSON 形式向 stdout 发送结构化事件（task_started / tool_called / tool_result / task_completed / task_failed / budget_exhausted），这些事件由 `engine._emit` 构造并经由 `HostChannel` 透传给 Host。这与 stderr 上的普通日志分离：stderr 用于调试/运维日志，stdout 用于协议级结构化事件。

### 3.5 Electron 侧
`apps/desktop/src/main` 下的 TypeScript 代码未包含显式日志调用；其通过 IPC 与 Python 子进程通信，依赖 Python 侧 stderr 日志进行诊断。

## 4. 约定与约束

- **必须通过 `runtime.py` 中的 `_setup_logging` 初始化日志**：该函数是唯一设置 level、handler 和 formatter 的地方，其他模块仅消费全局 `log`。
- **日志级别通过环境变量配置**：`PERSONAL_AGENT_LOG_LEVEL` 是唯一开关，取值应为 Python logging 标准级别之一（如 DEBUG/INFO/WARNING/ERROR），默认 `INFO`。
- **日志输出到 stderr**：生产环境应重定向 stderr 而非 stdout；stdout 专用于 JSON-RPC 协议消息。
- **禁止直接 `print()` 输出业务信息**：业务状态变更通过 `RunTaskEvent` 结构化事件上报，普通调试信息走 `log.info/warning/error`。
- **统一 logger 名称**：所有模块使用 `personal_agent` 命名空间，便于外部按名称过滤。
- **Electron 侧当前无日志框架**：如需在桌面端添加日志，需自行引入（如 pino/console），目前仓库未提供约定。

## 5. 适用范围

本日志体系覆盖 `services/agent-runtime` 下的 Python 进程；`apps/desktop` 与 `packages/protocol` 未集成日志系统。