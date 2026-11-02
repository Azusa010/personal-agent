# HTML 对话生成评测

该评测运行三个独立对话场景，每个场景五次，失败后在同一对话中最多修复一次。用例和固定数据见 `html-interaction-cases.json`。每次使用独立工作目录和数据库，实际经过 `sendMessage`、`runTask`、Python runtime、文件工具与权限链。测试权限只批准本次目标 HTML 的写入或修改，文件读取仅允许本次目标及 CSV 输入。

Windows 下从仓库根目录启动：

```powershell
$p = Start-Process -FilePath (Resolve-Path '.\node_modules\electron\dist\electron.exe') -ArgumentList @((Resolve-Path '.\tests\evals\html-live-launch.cjs').Path) -WindowStyle Hidden -PassThru -Wait
$p.ExitCode
```

启动器通过 Electron 的 `safeStorage` 使用桌面应用的当前模型配置，不输出密钥。设置 `HTML_EVAL_SMOKE=1` 仅运行一条诊断用例，不能计入正式 15 次。启动日志在 `reports/html-launch.log`，逐轮记录和最终报告在时间戳目录；报告目录被 Git 忽略。

余额耗尽时停止并将中断样本标记为基础设施故障。恢复服务后，可设置 `HTML_EVAL_ONLY`，例如 `csv-chart:4,csv-chart:5,choice-cards:1`，仅重跑指定编号；汇总时保留中断前的有效样本。如果模型或供应商改变，应分开报告，不能合并为同一配置的 15 次结果。

页面在独立 Electron 进程中运行，禁止网络、窗口打开和导航，仅暴露测试用 `evalHost.submit` / `ask`。页面检查进程有 20 秒超时，评测中的任务 RPC 最多等待 180 秒（规划沿用原有 60 秒上限）；截图与检查结果随每次结果保存。图表检测包含 SVG、Canvas 和常见 CSS 柱形元素，仍需人工复核截图。它不是生产运行容器，也不证明生产隔离安全。

`firstSuccess` 要求实际完成 Agent 任务、成功调用 `file_write`、生成页面并通过场景检查；`repairedSuccess` 同时要求修复任务完成。保存首轮文件、修复后文件、截图、检查错误、工具调用、耗时和任务结果。代理或供应商不可用等基础设施故障应单独标识，不能算作模型可靠性样本。输出的报告需要结合截图与数值证据人工复核；本评测没有验证任意图表像素或生产消息回传。
