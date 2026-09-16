# 演示清单（TASK-029）

两条演示路径，按手头条件挑一条：

| 路径 | 需要 | 走什么 |
| --- | --- | --- |
| **A. 剧本模式（默认）** | 无额外条件 | 确定性剧本（`tests/fixtures/scripts/golden-path.json`），与 CI 的 Golden Path E2E 同一份素材 |
| **B. 真模型模式** | `OPENAI_API_KEY` | 真模型（Responses API），验证 live 适配器 |

两条都是同一条产品链路：list → extract → create_dir → move → scheduler.create → 摘要，
每一步写操作都要经批准面板。

---

## 0. 一次性准备

- [ ] Windows 10/11；Node.js ≥ 22.13 与 pnpm 可用
- [ ] `pnpm install`
- [ ] 构建打包版：`pnpm package:dir`（约 2–3 分钟：先冻结 Python，再 electron-builder 打包）
- [ ] 想验通知的话，可选：`pnpm package:win` 生成 NSIS 安装包并安装（见第 3 节说明）

## 1. 剧本模式演示

### 启动

```powershell
powershell -File scripts/demo/start-demo.ps1              # 默认 3 分钟后提醒
powershell -File scripts/demo/start-demo.ps1 -RemindInMinutes 5
powershell -File scripts/demo/start-demo.ps1 -Dev         # 开发版（先 uv sync）
```

脚本会：重置演示根 `%TEMP%\personal-agent-demo`（只动这个目录）→ 放入 fixture PDF →
生成剧本 → 设 `PERSONAL_AGENT_DOWNLOADS_DIR` / `PERSONAL_AGENT_SCRIPT` → 启动 app。

> 提醒时刻在脚本运行时就算死了（剧本是静态 JSON，不支持「任务开始后 N 分钟」）。
> **三个批准面板要在它之前点完**：拖到过期的话 `scheduler.create` 会以
> `REMINDER_TIME_IN_PAST` 失败，交付物闸口照样判不通过——这也是产品的正确行为。

> 授权根指向演示目录，所以**不会碰你真实的 Downloads**。演示根路径在脚本输出里，
> 资源管理器可以开在那儿对照文件变化。

### 步骤

- [ ] 1. 在输入框发送：`整理 Downloads 里的 PDF，给出带页码引用的摘要`
- [ ] 2. 看计划出现五步（list → extract → create_dir → move → scheduler.create → 摘要）
- [ ] 3. 在批准面板点「批准」三次：创建 Reading、移动文件、创建提醒
- [ ] 4. 任务走到 completed，展开摘要与时间线核对
- [ ] 5. 打开「运行诊断」，看权限记录与事件
- [ ] 6. 等到提醒时间，观察 Windows 通知
- [ ] 7. 关闭窗口，确认进程退出干净（第 3 节）

### 观察点（逐条核对）

- [ ] **批准面板**每次都展示：能力名、影响文件、来源绝对路径、目标绝对路径、
      参数摘要、过期时间——且路径是**演示目录**下的绝对路径
- [ ] 三次批准都是「挂起等批准」：点批准之前，文件系统没有任何变化
- [ ] `Downloads\Reading\three-page-text.pdf` 真的存在了，源文件不在原位
- [ ] 摘要的 facts 带页码引用（第 1 页与第 2、3 页），页码可追溯到提取过的页面
- [ ] 时间线里能看到 `verification_started` / `verification_passed`：完成是交付物闸口
      判出来的，不是模型自称的
- [ ] 到点后弹一次 Windows 通知；诊断面板里 Reminder 状态为 `fired`

> 通知没弹？unpacked 版没有开始菜单快捷方式时，Windows 可能不显示通知——这不是发送失败。
> 判断依据看 Reminder 的状态与事件（诊断面板）：状态为 `fired` 且有 `notification_sent`
> 事件，就是发出去了。装 NSIS 安装包（`pnpm package:win`）后通知更可靠。

## 2. 真模型模式演示

与剧本模式的差别只在模型来源。先按第 1 节的方式准备素材（脚本会生成剧本），
然后**改用真模型启动**：

```powershell
$env:PERSONAL_AGENT_DOWNLOADS_DIR = "$env:TEMP\personal-agent-demo\Downloads"
$env:OPENAI_MODEL = "gpt-4o-mini"          # 换成你要用的模型
$env:OPENAI_API_KEY = "sk-..."             # 只被 openai SDK 读取
Remove-Item Env:\PERSONAL_AGENT_SCRIPT     # 真模型优先，但别留剧本免得看混
& "$PWD\apps\desktop\dist\win-unpacked\PersonalAgent.exe"
```

- [ ] 计划与工具调用由真模型决定（步骤顺序可能略有不同，最终要落到同一条完成条件）
- [ ] 摘要里的页码全部来自真实提取过的页面（闸口会拒掉编造的页码）
- [ ] 模型失败（网络、鉴权、配额）时任务以 `MODEL_CALL_FAILED` 收场，界面能看到原因

> 真模型跑批的评测入口是 `pnpm eval:live`（20 条 Case，需要 `EVAL_LIVE=1` +
> `OPENAI_MODEL` + `OPENAI_API_KEY`），口径见 [tests/evals/README.md](../tests/evals/README.md)。

## 3. 打包冒烟（TEST-015 的手工部分）

自动化那半在 `pnpm package:py && pnpm test:ts`（`runtime/packaged-runtime.test.ts`：
握手、剧本五步经反向 RPC、退出无孤儿、live SDK 随包可用）。手工这半验的是「整壳子」：

- [ ] 双击 `apps/desktop/dist/win-unpacked/PersonalAgent.exe`（不设任何环境变量）能启动
- [ ] 不配模型时发任务：状态栏/Runtime 提示正常，任务以 `RUNTIME_MODEL_NOT_CONFIGURED` 失败——
      这是预期的「没配模型」提示，不是崩溃
- [ ] 按第 1 节配好环境变量后能跑完整条链路
- [ ] 期间任务管理器里能看到 `PersonalAgent.exe` 与它拉起的 `personal_agent.exe`
- [ ] 关闭窗口后确认没有孤儿进程：

```powershell
Get-Process PersonalAgent, personal_agent -ErrorAction SilentlyContinue
# 输出为空 = 退出干净；python 侧进程残留 = 失败，需要排查 before-quit 的 stopRuntime
```

- [ ] NSIS 安装版（`pnpm package:win`）同样过一遍，并确认安装目录里
      `resources\agent-runtime\personal_agent.exe` 存在

## 4. 排障速查

| 现象 | 处理 |
| --- | --- |
| 启动后提示找不到运行时 | 界面会带出布局名与解析出的路径（`找不到运行时（打包布局）: ...`）。打包版：确认 `resources\agent-runtime\personal_agent.exe` 存在（`pnpm package:dir` 重打一次）；开发版：确认 `services/agent-runtime/.venv` 存在（`uv sync --project services/agent-runtime --locked`） |
| 任务立刻以 `RUNTIME_MODEL_NOT_CONFIGURED` 失败 | 既没设 `PERSONAL_AGENT_SCRIPT` 也没设 `OPENAI_MODEL`。用 start-demo.ps1 启动会自动设前者 |
| 脚本报「找不到打包版」 | 先跑 `pnpm package:dir`，或加 `-Dev` 用开发版 |
| 剧本 JSON 读取报错 | 脚本用无 BOM 写盘；若手工生成过剧本，注意别让编辑器写 BOM（Python 的 `json.loads` 会拒） |
| 想从零重来 | 删 `%APPDATA%\PersonalAgent\`（任务/事件/权限/提醒）与演示根 `%TEMP%\personal-agent-demo\` |