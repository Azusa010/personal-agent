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

**四轮路线**：R1 协议 + Python 发出端 → R2 TS 转发端（supervisor 路由 + IPC + preload）→ R3 渲染层（**陪练点**：`view-model.ts` 的 `applyStreamNotice`，边界与异常）→ R4 LiveModel 真流式 + 思维摘要（用假流式客户端测）。

**R1 状态（已收口，`pnpm verify` 全绿）**：protocol 150 / desktop 995+2skip / **pytest 349**（比预估的 302 多，含新增用例）/ ruff ✓。我方测试资产：两个 fixture、`packages/protocol/tests/agent-stream.test.ts`、envelope.test.ts 补 2 条 legalCases、`test_protocol_fixtures.py` 补 2 条、`services/agent-runtime/tests/test_stream.py`（15 条）、`golden-path.json` 六步各补 `thinking`。主人落盘的实现与参考代码等价（`_decide`/`plan` 用位置传参；`live_model.decide` 签名排版略紧凑），**唯一偏差可忽略、未回退**。
- 副作用：剧本现在真按 50ms 吐分块，golden-path E2E 跑 20 轮，`test:ts` 从 26.8s 涨到 29.6s。嫌慢调 `stream.py` 的 `THINKING_CHUNK_PAUSE_SECONDS`。

**R2 状态（测试已落盘，等主人落盘七块参考代码）**：新增 `main/runtime/python-supervisor.test.ts` +4 条（通知解析 emit 且不回包不写 stdin、event 分支透传、id 撞车不误 settle pending、非法通知只记 stderr）、`main/runtime/stream-fanout.test.ts` 5 条（订阅/多订阅者/退订幂等/互不影响/单订阅者抛异常不连累他人）、`main/e2e/stream.test.ts` 1 条真链路（钉「通知序列 = 落库事件序列」「思考落在所属决策之前」「delta 拼回与剧本逐字相同」）。红点 3 处全部指向实现缺失。参考代码：ipc-contract 加 `AgentStreamNotice`、新 `main/runtime/stream-fanout.ts`、supervisor `routeLine` 加 `AGENT_STREAM` 分支 + `handleStreamNotice`、runtime-host 挂 `publishAgentStream`、index.ts 加 `AGENT_STREAM_CHANNEL` 广播、preload 加 `onAgentStream` + index.d.ts 补类型。预期 R2 落盘后 desktop **1005 passed + 2 skipped**。
- **E2E 陷阱（重要）**：`e2e/stream.test.ts` 必须走 `beginTask` + 直接 `supervisor.request`，**不能走 `runTask`**——策略层要求「有当前任务」才放行工具调用（`currentTask()` 为空时用哨兵 id 直接拒），而这条线不需要落库那一半。落库/闸口/权限仍由 golden-path 与 conversation E2E 覆盖。
- **新增 `*.test.ts` 必须 `prettier --write` 转 LF**，否则 typecheck/web 的 `--skipLibCheck false` 会因 CRLF 报错（既有坑）。fixture JSON 与 `.py` 走 Windows 写入时也会带 CRLF，落盘后需统一归一成 LF（本轮 `golden-path.json`、两个 `.py` 都被我归一过；git 只是 warn，但保持 LF 一致更省事）。

**本轮明确不做**：回复正文逐字流式、思考落库、停止生成/取消任务、引 react-markdown 等新依赖、主题切换（暗色固定）、i18n。

相关：[[todo-batch-granularity]]、[[feedback-no-comment-restoration]]、[[task-031-conversational-agent-plan]]。
