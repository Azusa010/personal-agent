---
name: task-030-gui-model-settings-plan
description: TASK-030 界面化配置 OpenAI API 的完整方案与用户已拍板的范围决策——方案已出但 ExitPlanMode 被拒，尚未实施
metadata:
  node_type: memory
  type: project
  originSessionId: sess_381876ac-5cb6-4ec9-b99c-741c10b51c6d
---

2026-09-16 用户提出「界面化配置 API」功能（拟为 TASK-030）。我做了全链路探查并出了完整方案，通过 AskUserQuestion 确认了三项范围决策，但 **ExitPlanMode 被拒（Permission denied），方案未获批准，未写任何代码**，仓库仍干净停在 af4a837。下次继续时先与用户确认方案哪里要改，不要直接照单实施。

**用户已拍板的范围**：① 字段含 Key + Model + Base URL（Base URL 对国内中转是刚需）；② 保存后空闲时自动重启 Python runtime 生效，有任务在跑则提示「任务结束后重启生效」（不打断任务）；③ V1 不做「测试连接」按钮（留后续任务）。

**方案核心**（协议包与 Python 侧零改动，沿用 env 通道，避开 Zod↔Pydantic↔Fixtures 三步同步）：
- 现状链路：Python 子进程继承 Electron 的 process.env；OPENAI_MODEL 启动时读一次（runtime.py resolve_model_factory），key 由 openai SDK 首次调用时读——所以改配置必须重启子进程。PythonSupervisor 的 env 参数早已支持（整份替换）但 runtime-host 一直没传。
- 存储：`userData/model-settings.json`，apiKey 经 safeStorage（Windows DPAPI）加密成 base64；读失败一律视为未配置，不挡启动。
- 注入：startRuntime 里 `buildRuntimeEnv(process.env, settings)` —— 总是返回继承 env 的完整拷贝；已存字段覆盖对应 OPENAI_* 变量，未设字段保留继承值；**继承 env 有 PERSONAL_AGENT_SCRIPT 时三个变量都不注入**（剧本/演示模式是 per-launch 显式动作，压过持久设置，保 demo 确定性）。
- 重启：runtime-host 新增 restartRuntime()；PythonSupervisor 加 busy getter（pending.size > 0）判任务在跑。
- SEC-008 合规：get 接口只回 apiKeySet 布尔 + model/baseUrl，永不回传 key；表单显示「已配置（留空保持不变）」+ 清除密钥按钮。
- IPC：`personal-agent:get-model-settings` / `set-model-settings`，契约进 shared/ipc-contract.ts，新错误码 SETTINGS_ERROR_CODE（READ_FAILED/WRITE_FAILED/ENCRYPTION_UNAVAILABLE）并入 IpcErrorCode 联合。
- UI：SettingsDialog.tsx 仿 DiagnosticsDialog，复用已装好未用的 ui/input、ui/label；接 App.tsx L239 现成占位 `onSettings`；保存后 pollKey 自增重新轮询 runtime 状态。
- 新目录 `main/settings/`（model-settings.ts / settings-ipc.ts / error-code.ts + 两个测试），仿 permission-ipc.ts 的「纯函数 + 注入 deps」模式；需补 ADR-0001 偏差记录、DEVELOPMENT.md §4（L109「不显式传 env」说法要改）§6、DEMO.md、repowiki 增量。

**陪练点**：遵循 [[todo-batch-granularity]] 一次只推一个——唯一 TODO(你填)[思维与算法] 是 buildRuntimeEnv 纯函数，聚焦测试由 AI 全写好（TASK-029 resolvePackagedLaunch 同款红→绿打法）。ModelSettings 记录不加 readonly。

**探查中确认的关键事实**（省下次重查）：e2e 与 packaged-runtime.test.ts 都直接构造 PythonSupervisor、不走 startRuntime，runtime-host.test.ts 只测纯函数——startRuntime 加设置读取不炸现有测试。全仓无 dotenv/.env、无 electron-store、无任何设置持久化先例。eval 的 run-eval.ts 自己显式传 childEnv，不受 GUI 设置影响。
