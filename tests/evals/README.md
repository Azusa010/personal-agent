# Live Eval（TASK-027 / v1 扩展）

25 条预定义 Case 跑一遍完整链路，产出一份 JSON 报告：成功率、页码、工具、成本、
延迟，按维度分组。两个维度：

- **pdf_summary**（20 条，REQ-011 / TEST-013）：读文档、给带页码引用的摘要。
  握手只下发 READ 能力，计划三步，不改动授权根内容。
- **stateful_ops**（5 条）：归档移动 + Reminder。握手加发三个 WRITE
  （create_dir / move / scheduler_create），计划六步，真批准（eval 的「用户」
  是 fixture，权限一挂起就自动放行）、真建目录、真移动、真落 Reminder、真过
  交付物闸口。判定除了闸口的「该做的做了」，还查「不该做的一样没做」：
  目标进 Reading、根目录无副本、原有文件一个没少、Reading 里没卷进计划外文件
  （`judge.ts` 第七条判据，证据是现采的终态文件清单）。

```
cases.json          25 条 Case 的清单（FILE-021）。type 字段区分维度；页面文本、
                    目标文件、要点、期望终态都在这里
reports/            跑出来的报告与失败轨迹（不入库：.gitignore 排除了）
```

清单是唯一事实来源：PDF 由清单现场生成（`pdf-fixtures.ts` 的 `buildPdf`），
剧本也由清单合成，所以"清单里说第 3 页有 12% 增长"与"第 3 页真写着 12% 增长"
是同一份事实。改一条 case 只改这个文件。**约束**：stateful_ops 的目录名固定
Reading——planning.py 的 WRITE_STEPS 文案写死了它，改目录名先改那边再放开
case-manifest 的校验。

## 跑法（PowerShell）

`$env:` 变量粘在**整个会话**上，不是只对下一条命令生效。跑完想清干净：

```powershell
Remove-Item Env:OPENAI_API_KEY, Env:OPENAI_MODEL, Env:OPENAI_BASE_URL, Env:OPENAI_API_PROTOCOL, Env:EVAL_LIVE -ErrorAction SilentlyContinue
```

scripted 模式（确定性，CI 同款）不受残留变量影响——runner 会主动摘掉真模型配置。

```powershell
# scripted 模式（确定性）：每条 case 用清单合出来的剧本，真 Python + 真库 + 真闸口 + 真批准
pnpm eval        # 专用配置 vitest.eval.config.ts；test:ts 默认不含 eval（25 个子进程太重）

# live 模式（真模型，人手跑；没配环境变量就整块跳过）
$env:EVAL_LIVE = "1"
$env:OPENAI_MODEL = "<模型名>"
$env:OPENAI_API_KEY = "<key>"
$env:OPENAI_BASE_URL = "<中转或代理>/v1"      # 官方端点不用设
$env:OPENAI_API_PROTOCOL = "chat_completions" # 官方 Responses API 才用默认 responses
pnpm eval:live
```

想连美元成本一起统计，再加两个单价（USD / 百万 token，两个都给才算配好）：

```powershell
$env:EVAL_PRICE_INPUT_PER_MTOK = "0.15"
$env:EVAL_PRICE_OUTPUT_PER_MTOK = "0.6"
pnpm eval:live
```

没配单价时报告里的 `cost.usd` 是 `null`，token 数照记——留空比猜一个价格写死更诚实。

### 模型选型（pass^k / pass@k + 配对比较）

```powershell
# 每条 case 跑 3 次：报告的 fullSuccess 变成 pass^k 口径（每次都过才算过），
# passAtK 是 pass@k（至少一次过）。选型建议 runs ≥ 3
$env:EVAL_RUNS = "3"
pnpm eval:live

# 只跑指定 case（逗号分隔），调试卡住或失败的单条时用
$env:EVAL_CASES = "two-page-brief"
pnpm eval:live

# 两份报告逐 case 配对（第七章口径：只数不一致的对子；< 5 个在噪声带宽内）
pnpm eval:compare tests/evals/reports/live-A.json tests/evals/reports/live-B.json
```

25 条 case 的二项噪声约 ±13pp（95% CI）——独立两次成功率相减在 n=25 下基本是
噪声；配对比较只看独赢对子，这是小 n 下唯一有分辨力的比法。分维度 rates
（`metrics.byType`）用来找强弱项，不替代配对计数。

## 报告

live 模式的报告写在 `tests/evals/reports/live-<时间戳>.json`，形状见
`apps/desktop/src/main/eval/report.ts` 的 `EvalReportSchema`（带 `schemaVersion`）。
跑完 stdout 会打一屏摘要，最后一行是报告路径。

报告里有两层结论：

- `metrics.gates`：指导书 Phase 3 Exit Checklist 的四条闸口——完整成功 ≥90%
  （REQ-011）、页面引用准确率 ≥95%、关键结论召回 ≥90%（TEST-014）、无预算耗尽。
- `cases[]`：逐条 case 的判定明细。判定表在 `apps/desktop/src/main/eval/judge.ts`。
- `metrics.byType`：按维度的成功率分组，读链路与写链路的强弱项分开看。
- 失败 case 另落 `reports/trace-<caseId>-r<run>.json`（判定明细 + 观察快照），
  回看败在哪一步不用重跑。

## 边界

- **只读配置 vs 写配置**：读链路握手只发 READ（计划三步），写链路加发三个 WRITE
  （计划六步）。计划按可见能力伸缩（`planning.make_plan`），交付物闸口按计划推导
  要求——改能力清单时三处口径由架构对齐，不用逐处手改。
- **无澄清维度**：clarification 类 case 需要「向用户提问」的运行时通道，当前架构
  没有这条路径，属 v2 用户模拟器的范围，v1 不做假实现。
- **延迟**量的是任务本身的墙钟，不含进程启动与工作区物化：那两项是常量开销，
  计进去会淹没 scripted 模式的读数。
- live 模式每条 case 每一轮一个子进程，一条崩了不会污染下一条；scripted 模式同样，
  因为剧本是随进程启动读的（`PERSONAL_AGENT_SCRIPT`）。
- **部分报告**：live 每跑完一条就覆盖写 `reports/live-partial.json`，中断（Ctrl-C /
  断电）也保住已跑完的部分；最终报告 `live-<时间戳>.json` 仍以全部跑完为前提。
  单条任务的兜底超时约 42.7 分钟（RUN_TASK_TIMEOUT_MS），卡住的 case 别干等，
  Ctrl-C 后用 `EVAL_CASES=<id>` 单独复现。
