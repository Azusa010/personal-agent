---
kind: dependency_management
name: pnpm Monorepo + uv Python 双语言依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - apps/desktop/package.json
    - apps/desktop/.npmrc
    - packages/protocol/package.json
    - services/agent-runtime/pyproject.toml
    - services/agent-runtime/.python-version
    - services/agent-runtime/uv.lock
---

## 1. 使用的系统与工具

本仓库是一个多语言 monorepo，采用两套独立的依赖管理系统：
- **Node/TypeScript**：使用 `pnpm`（版本锁定在 `^11.17.0`），通过根级 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 管理。
- **Python**：使用 `uv`（构建后端为 `uv_build>=0.11.5,<0.12.0`），通过 `services/agent-runtime/pyproject.toml` 声明依赖，并通过 `uv.lock` 锁定所有传递依赖的精确版本与哈希。

根 `package.json` 中的 `devEngines.packageManager` 强制要求使用 pnpm `^11.17.0`，若未安装则自动下载，确保团队环境一致。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 根工作区脚本入口，统一 `test`/`build`/`verify` 等跨语言命令 |
| `pnpm-workspace.yaml` | 定义 workspace 包路径 (`apps/*`, `packages/*`, `services/*`)，设置 `nodeLinker: hoisted` 并显式允许/禁止某些包的 build 步骤 |
| `pnpm-lock.yaml` | Node 依赖的完整锁定文件（lockfileVersion 9.0） |
| `apps/desktop/package.json` | Electron 桌面应用依赖（Electron 39、React 19、Vite 7、better-sqlite3 等） |
| `packages/protocol/package.json` | 内部共享协议包 `@personal-agent/protocol`，标记 `private: true` |
| `services/agent-runtime/pyproject.toml` | Python 项目元数据、运行时依赖 (`openai>=3.6.0`, `pydantic>=2.13.5`)、开发依赖分组 (`dependency-groups.dev`) |
| `services/agent-runtime/.python-version` | 固定 Python 版本为 `3.13` |
| `services/agent-runtime/uv.lock` | Python 依赖的完整锁定文件（含 PyPI 源 URL 与每个 wheel/sdist 的 sha256 哈希） |
| `apps/desktop/.npmrc` | 仅配置 `shamefully-hoist=true`，无私有 registry |

## 3. 架构与约定

### 3.1 pnpm Monorepo 结构
- 工作区按目录划分：`apps/*`（可发布应用）、`packages/*`（内部共享库）、`services/*`（服务）。当前仅有 `apps/desktop` 和 `packages/protocol` 两个 Node 包。
- 使用 `hoisted` 节点链接器，所有依赖提升到根 `node_modules`，避免嵌套 `node_modules`。
- 通过 `allowBuilds` 白名单控制原生模块编译：允许 `electron`、`esbuild`、`electron-winstaller`，明确禁用 `better-sqlite3` 的构建（该包在 `apps/desktop` 中作为依赖存在，但构建被禁用以规避编译问题）。
- 包之间通过相对路径或 workspace 引用互相引用（`packages/protocol` 被 `apps/desktop` 消费，但当前未见显式 workspace 协议引用，可能通过本地路径解析）。

### 3.2 Python 依赖管理
- 使用 PEP 621 风格的 `pyproject.toml` 声明依赖，运行时依赖使用 `>=` 宽松语义，但通过 `uv.lock` 锁定到具体版本。
- 开发依赖通过 `[dependency-groups]` 的 `dev` 组集中管理（pytest、pytest-asyncio、ruff），与运行时依赖解耦。
- 构建系统由 `uv_build` 驱动，版本范围限定为 `>=0.11.5,<0.12.0`，防止上游破坏性更新。
- Python 版本通过 `.python-version` 固定为 `3.13`，与 `requires-python = ">=3.13"` 保持一致。
- 所有 Python 依赖从 `https://pypi.org/simple` 拉取，`uv.lock` 中每个包都记录 sdist 和 wheel 的完整 URL 及 sha256 哈希，保证可复现构建。

### 3.3 脚本与验证流程
根 `package.json` 提供统一的命令入口：
- `pnpm test`：依次执行 `test:pack`（protocol 包 vitest）、`test:ts`（desktop 应用 vitest）、`test:py`（uv run pytest）。
- `pnpm verify`：类型检查 + TypeScript lint + Python ruff 检查 + 全部测试。
- `pnpm verify:all`：在 verify 基础上追加 `build`。
- Python 侧使用 `uv run --project services/agent-runtime --locked` 运行，`--locked` 强制严格遵循 `uv.lock`，不允许隐式升级。

## 4. 约定与约束

- **包管理器锁定**：Node 端必须使用 pnpm（由 `devEngines` 强制），Python 端通过 `uv.lock` + `--locked` 标志强制锁定依赖树。
- **无私有 registry**：未发现任何 `.npmrc`、`.pypirc`、`pip.conf` 或 CI 环境变量指向私有 npm/PyPI 源；所有依赖来自公共源（npmjs、pypi.org）。
- **无 vendoring**：未使用 `vendor/` 或 `third_party/` 方式内嵌第三方源码；Node 依赖通过 pnpm 缓存，Python 依赖通过 uv 虚拟环境（`.venv`）管理。
- **内部包标记**：`packages/protocol` 标记为 `private: true`，表明它是 monorepo 内部共享包，不对外发布。
- **原生模块构建策略**：通过 `pnpm-workspace.yaml` 的 `allowBuilds` 显式管控哪些包允许执行构建脚本，`better-sqlite3` 被明确禁止构建，体现对原生编译风险的主动规避。
- **Python 开发依赖隔离**：通过 `dependency-groups.dev` 将测试/格式化等工具与运行时依赖分离，便于最小化生产镜像。
- **版本策略**：Node 依赖普遍使用 `^` 前缀（如 `zod ^4.5.4`、`react ^19.2.1`），Python 运行时依赖使用 `>=` 宽松语义，但均通过 lockfile 锁定实际安装版本。