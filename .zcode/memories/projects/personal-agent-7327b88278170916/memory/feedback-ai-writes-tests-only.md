---
name: feedback-ai-writes-tests-only
description: 分工铁律——AI 只写测试文件，其余一切实现（含 schema/接线样板）都以参考代码形式交给主人落盘
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_61437b2f-4240-4a5e-be5f-9acd618ca5b0
---

2026-09-17 主人明确（TASK-031 R5 期间）：「下次还是按照给出参考代码的方式，你只负责写好测试文件」。此前我在 R5 把协议 schema、fixtures、engine 接线、run-eval 等非测试文件也直接写进了仓库——他纠正了这个越界。

**Why**：他要自己写全部实现代码，样板也是练习对象；AI 的所有权边界是**测试文件**（场景、数据、断言），这样 `pnpm verify` 的红绿反馈由 AI 保证，实现的理解与手感归主人。

**How to apply**：
- 每个 TASK/轮次：AI 只 Write/Edit **测试文件**（`test_*.py` / `*.test.ts`）与**文档**（ADR、DEVELOPMENT.md、AGENTS.md、DEMO.md、repowiki——2026-09-17 追加「这种文档类的你负责更新」）；其余一切代码——Zod schema、Pydantic 镜像、engine/runtime 接线、UI——给「整段可粘贴的参考代码」由主人落盘（含中文标点的字符串务必提醒整段粘贴，防半角漂移，见 [[feedback-no-comment-restoration]] 同一轮的教训）。
- **fixture 归属已确认（2026-09-18，TASK-033）**：`packages/protocol/fixtures`（契约样本，双端测试消费）算**测试资产，AI 直接写**，不用再确认。另外**游戏素材类**的 `tests/fixtures/scripts/*.json`（剧本）也照此办——TASK-033 我给 `golden-path.json` 每步补 `thinking` 是直接落盘的，主人无异议。
- **参考代码要「逐块提醒整段粘贴」**：TASK-033 R1 我一次交付八块参考代码（agent.ts schema / models.py 镜像 / 新 stream.py / model_gateway / scripted_model / engine / planner 三处签名 / runtime 接线），每块都标了「请整段粘贴，别手抄」——他照做，落盘后 `pnpm verify` 一次回绿、无隐蔽漂移。**这条路子有效，继续用**。
- **落盘后 AI 自己跑一遍 `pnpm verify` 复核**（主人只回一句「通过了」），并把与参考代码的差异如实报出来——TASK-033 R1 的差异只是位置传参与签名排版，无行为影响；有偏差时说明「可忽略/未回退」而不是悄悄放过。
- R5 我直接落盘的部分未回退（主人说「下次」），从 R6 起严格执行。相关：[[task-031-conversational-agent-plan]]、[[todo-batch-granularity]]、[[task-033-streaming-persona-ui-plan]]。
