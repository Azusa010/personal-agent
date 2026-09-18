---
name: feedback-no-comment-restoration
description: 主人明确「注释不用管」——别为补回被删注释单开一轮或反复提醒
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_61437b2f-4240-4a5e-be5f-9acd618ca5b0
---

2026-09-17 在 TASK-031 的 R1 评审里，我列出五处被删掉的「为什么」注释（MAKE_PLAN_TIMEOUT_MS 理由、KNOWN_IPC_CODES 收码规则、`verify` 的 docstring 等）建议恢复；主人回「注释不用管」。

**Why**：他要的是跑通链路与理解设计取舍，不想在补回历史注释上花轮次。

**How to apply**：给参考代码时正常带上注释（他粘贴时会一起进仓库），但不要为「恢复被删注释」单开一轮、也不要反复提醒；发现注释缺失最多一句带过。注意这不等于不写注释——新写代码该有的「为什么」注释照写，只是不追讨历史注释。相关：[[task-031-conversational-agent-plan]]。