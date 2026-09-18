---
name: task-033-streaming-persona-ui-plan
description: TASK-033/034/035（流式输出 / 思维链 / agent 人设 / 前端美化）的设计口径与四轮路线，R1 已落盘收口、R2 测试已交付
metadata:
  node_type: memory
  type: project
  originSessionId: sess_c28eee51-1332-4671-bd36-0e03c42fc7cf
---

2026-09-18 主人提出「优化前端显示内容流式输出，思维链输出，agent 人设设置，前端 UI 美化」，拆成 TASK-033/034/035（**不是** TASK-031 的延续，是新的一批）。方案经 AskUserQuestion 拍板后**已批准**（ExitPlanMode 第二次通过；第一次被拒）。

**主人拍板的四项口径（别再重开）**：
- 流式做到「**事件流 + 思维链**」——计划/工具调用/工具结果等事件实时推 + 推理摘要逐字出现；**正文仍在摘要决策落地时整段出现**，不做「从流式 JSON 里抠 reply 的增量提取」（他明确没选那档）。
- 人设走「**独立设置文件 + 随请求下发**」——新 `agent-profile.json` + 新 IPC 通道；人设随 make_plan/run_task 参数下发。**不往 model-settings.json 加字段**（那文件 version 一改整份作废 = 主人要重填 API Key），且走请求参数改完立即生效、不用重启 runtime。
- UI 美化优先做：**消息呈现、流式与动效、布局与层次**（他**没选**令牌与文案/i18n 那一项）。
- fixture 归属已确认算**测试资产**（见 [[feedback-ai-writes-tests-only]] 里那条待确认边界）。

**关键设计结论**：
- 传输走 **JSON-RPC 通知**（`Notification` 信封在 Zod 与 Pydantic 两侧都已存在、全仓零使用，本来就是给这类推送留的口子）：新方法 `agent.stream`，params 按 `kind` 判别（`event` 带 RunTaskEvent 副本 / `thinking` 带 delta）。
- **通知是尽力而为的预览，回包仍是唯一事实来源**：events 照旧全量回传，落库、交付物判定、GOLDEN_EVENT_TYPES 钉点全不变；通知丢了只影响观感。
- **思考不落库**，只活在生成时（`buildHistory` 只看 messages 表）；刷新后看不到思维链是刻意取舍。
- 思维摘要开关放人设文件（`reasoningSummary`，**默认关**）：关 = 今天的 `responses.create` 零回归；开 = `responses.stream` + `reasoning: {summary:"auto"}`（非推理模型会 400）。
- engine/runtime 用「**有 sink 才传 `on_thinking`**」的调用形状——这样「不接线 = 完全不碰既有路径」字面成立，`test_runtime.py`/`test_planner_wiring.py` 里只实现 `decide(context)` 的替身一个都不用改（试过统一传参会把 3 条既有结算用例弄红，已回退）。
- `model_usage` 不进实时流：`_settle_usage` 直接构造事件、绕过 `_emit`，天然不在流里（它是结算不是过程）。

**四轮路线**：R1 协议 + Python 发出端（✅ 收口）→ R2 TS 转发端（supervisor 路由 + IPC + preload，✅ 收口）→ R3 渲染层（`view-model.ts` 的 `applyStreamNotice`，✅ 收口）→ R4 LiveModel 真流式 + 思维摘要（`live_model`/`live_planner` 真流式接入，✅ 收口）。全四轮均已全绿收口。

**TASK-034（Agent 人设）**：
- R1 存储与请求级下发（✅ 收口）：ProfileDto 进 Zod/Pydantic/Fixtures 三处同步，`userData/agent-profile.json` 独立存储层与校验，IPC 通道与 Preload 暴露，`runTask` 请求级挂参。
- R2 Python 注入（陪练点 `compose_instructions`）+ 前端设置面板分区（待开始）。

**终态数据（`pnpm verify` 全绿）**：protocol **157** / desktop **1038 passed** + 2 skipped / **pytest 360** / ruff ✓ / typecheck ✓ / eslint ✓。
- TASK-033 终态：protocol 150 / desktop 1015 / pytest 357。
- TASK-034 R1 终态：protocol 157（+7）/ desktop 1038（+23）/ pytest 360（+3）。

**本轮明确不做**：回复正文逐字流式、思考落库、停止生成/取消任务、引 react-markdown 等新依赖、主题切换（暗色固定）、i18n。

相关：[[todo-batch-granularity]]、[[feedback-no-comment-restoration]]、[[task-031-conversational-agent-plan]]。
