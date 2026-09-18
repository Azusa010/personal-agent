---
name: task-031-conversational-agent-plan
description: 对话式 agent 改造（TASK-031/032）已完成收口——设计口径、11+ 轮陪练路线与最终状态
metadata:
  node_type: memory
  type: project
  originSessionId: sess_61437b2f-4240-4a5e-be5f-9acd618ca5b0
---

2026-09-17 用户提出「把这个先真的搓成一个对话式 agent」。方案批准为**陪练节奏**交付（分工见 [[feedback-ai-writes-tests-only]]：AI 只写测试与文档，其余实现一律参考代码由主人落盘），拆两个 TASK，**均已收口**（2026-09-17，工作区未提交）：

- **TASK-031**：按目标规划 + 自然语言回复（单轮）。Planner 端口（Deterministic/Live）、`RunTaskParams.plan`、`SummaryDecision.reply`、摘要校验按计划分档、闸口 `reply_present`、提示词去写死五步。
- **TASK-032**：多轮会话。migration 0009（conversations/messages/tasks.conversation_id）、`buildHistory` 陪练点、send-message 编排、history 契约与 Python 渲染、IPC 三通道 + UI 消息流（主人引入 TanStack Query）。

**关键设计结论（别再重开）**：计划仍是执行前合约（Alignment 与交付物闸口按计划推导）；LivePlanner 的计划清洗 fail-closed（违规整份作废 → `PLAN_MODEL_FAILED`）；剧本不参与规划（CON-006）；零工具轮次允许（闸口 `reply_present` + 取证缺口按计划分档）；任务↔会话关联以 messages.task_id 为准；确定性模式下每任务领新 ScriptedModel、同剧本重放。

**门禁终值**：protocol 135 / desktop 995 passed + 2 skipped（68 files，含会话 E2E）/ pytest 333。文档已落盘：ADR-0001（TASK-031/032 两条）、DEVELOPMENT.md §5、AGENTS.md §6 两条先例（verify_summary 分档、buildHistory + 双重发送 bug）、DEMO.md 多轮段。

**遗留**：① 代码已由主人自行提交（eb3fb39 等三个 feat）+ 我方三刀收尾（abbbf19 会话 E2E / 5e84dc6 App 导入清理 / 1dedd10 文档收口）；② repowiki 增量（两轮欠账）**未做**——2026-09-17 试做一轮后回滚，实测结论与操作清单写在本地 `docs/DEVELOPMENT.md` §5 欠账行（该文件被 gitignore 挡着、本地维护）：reanchor 要迭代跑到收敛、重写文件的人工项可按导出清单脚本批量应用但需语义复核、另有约 10 页内容增量；建议单独一个会话做（流程见 [[repowiki-incremental-update]]）；③ `pnpm eval:live`（Phase 3 两格欠账）与真模型下的多轮冒烟待主人跑；④ 陪练点全清零（verify_summary、buildHistory 均已填完）。相关：[[todo-batch-granularity]]、[[feedback-no-comment-restoration]]。