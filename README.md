# PersonalAgent

PersonalAgent 是一个本地优先（local-first）的桌面 AI Agent：

- **桌面端**：Electron + React（`apps/desktop`）
- **共享协议**：Zod 契约包（`packages/protocol`）
- **运行时**：Python Agent Runtime（`services/agent-runtime`）

主进程（Electron Main）是唯一可信执行边界：权限审批、路径沙箱、工具执行、任务状态持久化都在主进程完成；Python 运行时负责规划与推理，通过 stdio NDJSON JSON-RPC 与主进程通信。

> 结构化设计文档优先参考：[`/.repowiki/zh/content`](.repowiki/zh/content)
> （如与源码冲突，以源码为准）

---

## 1. 当前核心能力（基于源码）

当前能力集合已不再是早期 V0.1 的单链路 Demo，默认包含以下能力族（见 `apps/desktop/src/main/capabilities/registry.ts` 与 `plugins/`）：

- 文件系统与文档：目录列举、创建目录、文件移动、文件搜索、文件读写/精确编辑、PDF/多格式文档读取
- 终端与计算：受限目录内终端命令执行（`terminal_execute`）、隔离代码解释执行（`code_interpreter`）
- 知识能力：knowledge 检索、user memory 检索、Viking L0/L1/L2 读写
- 外部检索与技能：`web_search`、`skill_search` / `skill_read`
- 应用交互：Reminder 调度、系统通知（内部能力）、A2UI 渲染

---

## 2. 架构与工作区结构

### 2.1 Monorepo 结构

```text
personal-agent/
├─ apps/
│  └─ desktop/                 # Electron + React 应用（main/preload/renderer）
├─ packages/
│  └─ protocol/                # 共享协议：Zod schema + fixtures
├─ services/
│  └─ agent-runtime/           # Python runtime（pydantic 镜像、策略、模型接入）
├─ docs/                       # 设计、演示、ADR 文档
├─ scripts/                    # 演示/工具脚本
├─ tests/                      # fixtures 与 eval 相关资源
└─ .repowiki/                  # 仓库结构化知识快照
```

### 2.2 运行时分层

```text
Renderer (React)
  -> Preload (contextBridge 白名单)
  -> Main (权限、路径校验、执行副作用、持久化)
  -> Python Runtime (规划/推理)
```

---

## 3. 环境要求

### 必需

- Node.js >= 22.13
- pnpm ^11.17（建议用 corepack）
- Python >= 3.13
- uv（Python 依赖与命令入口）

### 平台现状

- 打包与官方演示链路当前以 **Windows 10/11** 为目标（`package:dir` / `package:win`、`start-demo.ps1`）

---

## 4. 安装与开发

在仓库根目录执行：

```powershell
pnpm install
uv sync --project services/agent-runtime --locked
```

### 启动方式

```powershell
# 开发模式（推荐）
pnpm --dir apps/desktop dev

# 预览已构建产物（先 build 后再用）
pnpm --dir apps/desktop start
```

---

## 5. 测试与验证命令

### 5.1 推荐门禁（提交前）

```powershell
pnpm verify
```

`pnpm verify` 会串行执行：

- `pnpm typecheck`
- `pnpm lint:ts`
- `pnpm lint:py`
- `pnpm test`（包含 protocol + desktop + python）

### 5.2 常用分项命令

```powershell
pnpm test:pack
pnpm test:ts
pnpm test:py

pnpm eval
pnpm eval:live
pnpm check:islands
pnpm check:islands:strict
```

> live eval 依赖模型凭据，详情见 [`tests/evals/README.md`](tests/evals/README.md)

---

## 6. 构建与打包（Windows）

```powershell
pnpm build         # electron-vite build（不打包）
pnpm package:py    # 先冻结 Python runtime（PyInstaller）
pnpm package:dir   # 免安装目录：apps/desktop/dist/win-unpacked/
pnpm package:win   # NSIS 安装包：apps/desktop/dist/
```

`package:dir` / `package:win` 已内置“两步链路”：先 `package:py`，再 electron-builder。

---

## 7. 运行与配置（环境变量）

以下变量来自当前源码（`runtime-host.ts`、`roots.ts`、`model-settings.ts`、`runtime.py`）：

| 变量 | 作用 | 默认/备注 |
| --- | --- | --- |
| `PERSONAL_AGENT_DOWNLOADS_DIR` | downloads 授权根 | 默认 `~/Downloads` |
| `PERSONAL_AGENT_WORKSPACE_DIR` | workspace 授权根（文件读写/终端等） | 默认进程工作目录 |
| `PERSONAL_AGENT_SCRIPT` | 指定剧本 JSON（确定性模式） | 常用于 demo/CI |
| `OPENAI_MODEL` | 启用真模型 | 若与 `PERSONAL_AGENT_SCRIPT` 同时设置，runtime 侧优先真模型 |
| `OPENAI_API_KEY` | 真模型 API Key | 可由 SDK 直接读取 |
| `OPENAI_BASE_URL` | 模型服务基地址 | 可选 |
| `OPENAI_API_PROTOCOL` | OpenAI 协议类型 | 由设置页/环境注入 |
| `PERSONAL_AGENT_RUNTIME` | 覆盖 runtime 可执行入口 | 排障/冒烟口子 |
| `PERSONAL_AGENT_STRATEGY` | live 模式策略（如 `plan_execute`/`react`） | 默认 `plan_execute` |
| `PERSONAL_AGENT_SANDBOX_PYTHON` | 覆盖 code sandbox 的 Python 解释器 | 可选 |
| `PERSONAL_AGENT_VIKING_ROOT` | Viking 存储根目录 | 可选 |

---

## 8. Windows 演示流程（保留并按现状修正）

### 8.1 剧本模式（推荐首次体验）

```powershell
pnpm install
pnpm package:dir
powershell -File scripts/demo/start-demo.ps1
```

脚本会自动：

1. 准备演示目录与 fixture PDF
2. 生成带 `{{DOWNLOADS_ROOT}}` / `{{REMIND_AT}}` 替换值的剧本
3. 设置 `PERSONAL_AGENT_DOWNLOADS_DIR` 与 `PERSONAL_AGENT_SCRIPT`
4. 启动打包版（可加 `-Dev` 用开发版）

完整步骤与排障见：[`docs/DEMO.md`](docs/DEMO.md)

### 8.2 真模型模式

`docs/DEMO.md` 同时提供真模型演示路径（含环境变量示例与注意事项）。

---

## 9. 数据位置

桌面端数据默认写入 `%APPDATA%\PersonalAgent\`（Windows）：

- `product-state.db`：任务、事件、权限、提醒等产品状态
- `personal-agent.db`：PDF 索引等数据
- `model-settings.json`：模型设置（敏感字段经系统安全存储加解密）
- `agent-profile.json`：Agent 档案设置

---

## 10. 安全模型（当前实现）

工具调用按纵深链路执行：

1. **Scope**：任务可见能力范围
2. **Retriever**：能力注册校验
3. **Binder**：参数 schema 校验 + 路径绑定
4. **Executor**：策略与审批门禁
5. **Path-Guard**：`resolveWithinRootReal` 防越界/链接逃逸/UNC 等

同时，写操作走审批流程与持久化权限记录；渲染进程经 preload 白名单调用主进程 IPC，避免直接拿系统权限。

---

## 11. 当前限制与注意事项

- 打包分发链路当前以 Windows 为主，官方演示脚本也是 PowerShell
- 运行时与能力都受授权根约束，越界路径会被拒绝
- 若既无 `PERSONAL_AGENT_SCRIPT` 也无可用模型配置，任务会以“未配置模型”相关错误结束
- live 能力（网络/模型）依赖本地环境与凭据，CI 默认走剧本/离线路径

---

## 12. 相关文档

- 演示手册：[`docs/DEMO.md`](docs/DEMO.md)
- Agent 元能力规范：[`docs/AGENT_SPEC.md`](docs/AGENT_SPEC.md)
- 架构与开发文档导航：[`/.repowiki/zh/content`](.repowiki/zh/content)

