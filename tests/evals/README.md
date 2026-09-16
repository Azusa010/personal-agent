# Live Eval（TASK-027）

20 条预定义 Case（REQ-011 / TEST-013）跑一遍完整链路，产出一份 JSON 报告：
成功率、页码、工具、成本、延迟（TASK-027 的 Validation）。

```
cases.json          20 条 Case 的清单（FILE-021）。页面文本、目标文件、要点都在这里
reports/            跑出来的报告（不入库：.gitignore 里排除了）
```

清单是唯一事实来源：PDF 由清单现场生成（`pdf-fixtures.ts` 的 `buildPdf`），
剧本也由清单合成，所以"清单里说第 3 页有 12% 增长"与"第 3 页真写着 12% 增长"
是同一份事实。改一条 case 只改这个文件。

## 跑法

```bash
# scripted 模式（CI 默认，确定性）：每条 case 用清单合出来的剧本，真 Python + 真库 + 真闸口
pnpm eval

# live 模式（真模型，人手跑；没配环境变量就整块跳过）
EVAL_LIVE=1 OPENAI_MODEL=<模型名> OPENAI_API_KEY=<key> pnpm eval:live
```

想连美元成本一起统计，再给两个单价（USD / 百万 token，两个都给才算配好）：

```bash
EVAL_LIVE=1 OPENAI_MODEL=… OPENAI_API_KEY=… \
  EVAL_PRICE_INPUT_PER_MTOK=0.15 EVAL_PRICE_OUTPUT_PER_MTOK=0.6 pnpm eval:live
```

没配单价时报告里的 `cost.usd` 是 `null`，token 数照记——留空比猜一个价格写死更诚实。

## 报告

live 模式的报告写在 `tests/evals/reports/live-<时间戳>.json`，形状见
`apps/desktop/src/main/eval/report.ts` 的 `EvalReportSchema`（带 `schemaVersion`）。
跑完 stdout 会打一屏摘要，最后一行是报告路径。

报告里有两层结论：

- `metrics.gates`：指导书 Phase 3 Exit Checklist 的四条闸口——完整成功 ≥18/20
  （REQ-011）、页面引用准确率 ≥95%、关键结论召回 ≥90%（TEST-014）、无预算耗尽。
- `cases[]`：逐条 case 的判定明细。判定表在 `apps/desktop/src/main/eval/judge.ts`。

## 边界

- **只读链路**：`filesystem.list → document.extract_pdf → summary`。不改动授权根内容，
  不涉及 WRITE 能力与权限批准（那条链路在 TASK-026 的 Golden Path E2E 与安全矩阵里）。
- **延迟**量的是任务本身的墙钟，不含进程启动与工作区物化：那两项是常量开销，
  计进去会淹没 scripted 模式的读数。
- live 模式每条 case 一个子进程，一条崩了不会污染下一条；scripted 模式同样一条一进程，
  因为剧本是随进程启动读的（`PERSONAL_AGENT_SCRIPT`）。
