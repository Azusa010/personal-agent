# PersonalAgent（V0.1 Demo）

Windows 上的本地优先个人助理。V0.1 只对一条链路负责，把这条链路做可靠：

> 找到 Downloads 里最近的文本型 PDF → 生成带页码引用的摘要 → 经你逐项批准后移动到
> Reading 目录 → 建一条到点通知的一次性提醒（应用重启后仍会补发）。

架构一句话：**Electron（TypeScript）是唯一可信运行时**——路径校验、权限判定与副作用执行
全部在这里；Python 只负责 Agent Loop 与模型交互，两者以 stdio + NDJSON JSON-RPC 通信。
协议契约、安全边界与模块结构的详细说明见仓库内 wiki：[`.repowiki/zh/content/`](.repowiki/zh/content/)。

---

## 一、跑一场演示（最短路径）

前置：Windows 10/11 + Node.js ≥ 22.13 + pnpm ^11.17（corepack 可用）。
不需要装 Python：打包会把 Agent Runtime 冻结进安装目录。

```powershell
pnpm install                                  # 一次性
pnpm package:dir                              # 一次性：构建免安装版（含 Python 冻结产物）

powershell -File scripts/demo/start-demo.ps1  # 每次演示：备好素材并启动
```

脚本会准备一份干净的演示 Downloads（含 fixture PDF）、按当前时间生成确定性剧本、
设好环境变量后启动 app。窗口里发送：

```
整理 Downloads 里的 PDF，给出带页码引用的摘要
```

随后依次批准三次写操作（创建 Reading、移动文件、创建提醒），核对摘要页码、时间线，
并等到提醒弹出通知。**完整步骤、观察点与排障见 [docs/DEMO.md](docs/DEMO.md)。**

脚本默认启动打包版；加 `-Dev` 改用开发版（走仓库 venv，需先 `uv sync`）。
换真模型（不用剧本）的演示步骤同样在 [docs/DEMO.md](docs/DEMO.md)。

---

## 二、从源码开发

| 前置 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.13 | 由 pnpm 的 `devEngines` 指定 |
| pnpm | ^11.17 | — |
| Python | ≥ 3.13 | Agent Runtime（`services/agent-runtime/pyproject.toml`） |
| uv | 最新 | Python 侧包管理 |

```powershell
pnpm install
uv sync --project services/agent-runtime --locked   # 建 .venv

pnpm --dir apps/desktop dev    # 开发模式（热重载）；根 pnpm dev 是预览已构建产物
pnpm verify                    # 提交前的全部门禁（类型、lint、三语言测试）
```

`pnpm verify` 一次跑完 7 项：TS 类型、ESLint、ruff、protocol vitest、desktop vitest、
pytest。测试里有两组会真起 Python 子进程的端到端（完整 Golden Path 20 轮、失败回归集），
以及一组打包冒烟——后者要先把冻结产物构建出来才会真的跑：

```powershell
pnpm package:py       # 只构建 Python 冻结产物（services/agent-runtime/dist/personal_agent/）
pnpm test:ts          # 再跑测试：runtime/packaged-runtime.test.ts 从 skip 变为执行
```

---

## 三、打包与分发

```powershell
pnpm package:dir   # 免安装目录 → apps/desktop/dist/win-unpacked/PersonalAgent.exe
pnpm package:win   # NSIS 安装包  → apps/desktop/dist/PersonalAgent-1.0.0-setup.exe
pnpm build         # 只构建（electron-vite），不打包
```

打包分两步，顺序在 `package:*` 里已经串好：

1. `package:py`——PyInstaller 按 `services/agent-runtime/packaging/personal_agent.spec`
   把 Python runtime 冻成 onedir 包（约 33 MB，含 openai/pydantic 全部依赖）；
2. `build:win` / `build:unpack`——electron-builder 按 `apps/desktop/electron-builder.yml`
   把上一步产物复制到安装目录的 `resources/agent-runtime/`，再生成安装包。

运行时位置由 `runtime-host.ts` 的 `resolveRuntimeLaunch` 按布局解析：
打包态找随包冻结产物，开发态找仓库 `.venv`，`PERSONAL_AGENT_RUNTIME` 可整体覆盖。
找不到时 Runtime 落 `crashed` 并在界面上给出可读原因，不会静默降级。

V0.1 只出 Windows 产物（CON-003）；升级靠重装新版本，没有自动更新。

---

## 四、环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PERSONAL_AGENT_DOWNLOADS_DIR` | `~/Downloads` | 唯一授权根的实际路径，所有工具路径校验以它为界 |
| `PERSONAL_AGENT_SCRIPT` | 未设 | 确定性剧本 JSON 的路径（演示与 CI 用它替代真模型） |
| `OPENAI_MODEL` | 未设 | 设了就改用真模型（Responses API），模型名由此读取 |
| `OPENAI_API_KEY` | 未设 | 真模型模式的 API Key（只被 openai SDK 读取，不进日志与事件） |
| `PERSONAL_AGENT_RUNTIME` | 未设 | 覆盖运行时命令，指向自带入口的可执行文件（排障用） |

`PERSONAL_AGENT_SCRIPT` 与 `OPENAI_MODEL` 至少要有一个，否则任务会以
`RUNTIME_MODEL_NOT_CONFIGURED` 收场（这是刻意的：静默降级会让人以为模型跑通了）。
完整环境变量表与取值细节见 `.repowiki/zh/content/开发指南/环境搭建.md`。

---

## 五、已知限制（V0.1）

- 只支持 Windows 10/11，不承担 macOS/Linux 分发；
- 只处理**可提取文本**的 PDF：扫描件、加密、空文本文件会以稳定错误码失败，不做 OCR；
- 授权根只有 `downloads` 一个（Reading 是它下面的子目录）；
- 不注册 Shell、代码执行、删除、覆盖与任意网络工具；文件操作只有 create_dir 与 move；
- 没有自动更新与安装器签名：安装包会触发 SmartScreen 提示，属预期行为。

## 六、数据与日志

| 内容 | 位置 |
| --- | --- |
| 任务/事件/权限/提醒 | `%APPDATA%\PersonalAgent\product-state.db` |
| PDF 索引 | `%APPDATA%\PersonalAgent\personal-agent.db` |
| Python 日志 | 开发模式转发到终端 stderr；打包版不落文件 |

删掉上面两个 `.db` 等于恢复出厂状态。提醒在应用启动时会按状态恢复：未来的重挂、
错过的补发一次、已发送的绝不重发。