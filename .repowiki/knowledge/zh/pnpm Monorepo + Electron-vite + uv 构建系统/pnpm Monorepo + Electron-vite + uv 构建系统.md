---
kind: build_system
name: pnpm Monorepo + Electron-vite + uv 构建系统
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - apps/desktop/package.json
    - apps/desktop/electron.vite.config.ts
    - apps/desktop/electron-builder.yml
    - services/agent-runtime/pyproject.toml
    - services/agent-runtime/.python-version
    - packages/protocol/package.json
---

## 1. 使用的系统与工具

- **包管理与工作区**：根目录使用 `pnpm` 作为统一包管理器，通过 `pnpm-workspace.yaml` 声明三个工作区范围 `apps/*`、`packages/*`、`services/*`，并启用 `nodeLinker: hoisted`。
- **Node/TypeScript 应用（桌面端）**：`apps/desktop` 基于 `electron-vite`（Vite 7）进行开发/构建，使用 `electron-builder` 打包为 Windows (NSIS)、macOS (dmg)、Linux (AppImage/snap/deb) 多平台安装包。
- **Python 服务（Agent Runtime）**：`services/agent-runtime` 使用 `uv`（`uv_build>=0.11.5,<0.12.0` 作为 build-backend），通过 `pyproject.toml` 管理依赖与脚本入口 `personal_agent = "personal_agent:main"`，Python 版本锁定在 `.python-version` 中的 `3.13`。
- **协议包**：`packages/protocol` 是纯 TypeScript schema 包，被桌面端通过路径别名 `@personal-agent/protocol` 引用。
- **测试**：TS/Vitest 位于 `apps/desktop` 和 `tests/`；Python 使用 `pytest`（由 `uv run --project services/agent-runtime --locked pytest` 调用）。
- **代码质量**：TS 使用 ESLint + Prettier；Python 使用 Ruff（`ruff check .` / `--fix`）。

## 2. 关键文件

- 根级编排：`package.json`（顶层 scripts）、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。
- 桌面端构建：`apps/desktop/electron.vite.config.ts`（Vite/Electron 配置）、`apps/desktop/electron-builder.yml`（打包产物与发布配置）、`apps/desktop/package.json`（构建脚本与依赖）。
- Python 服务：`services/agent-runtime/pyproject.toml`（项目元数据、build-system、dependency-groups、pytest 配置）、`services/agent-runtime/.python-version`。
- 协议包：`packages/protocol/package.json`、`packages/protocol/schemas/index.ts`。

## 3. 架构与约定

- **Monorepo 脚本编排**：根 `package.json` 的 scripts 通过 `pnpm --dir <workspace>` 将各子模块的脚本串联起来，提供统一的 `dev`、`build`、`test`、`verify`、`verify:all` 入口。Python 相关命令通过 `uv run --project services/agent-runtime --locked ...` 调用，确保使用锁定的依赖环境。
- **依赖方向**：`apps/desktop` 通过 Vite 的 `resolve.alias` 将 `@personal-agent/protocol` 指向 `../../packages/protocol/schemas/index.ts`，实现跨包类型共享而不需要发布 npm 包。
- **构建流水线**：
  - `pnpm verify` → `typecheck` + `lint:ts` + `lint:py` + `test`（pack/ts/py）。
  - `pnpm verify:all` → `verify` + `build`。
  - 桌面端构建流程：`npm run typecheck && electron-vite build`，随后 `electron-builder` 按平台生成安装包。
- **打包约束**：`electron-builder.yml` 排除源码、配置文件等，仅打包 `out/` 产物；`asarUnpack` 保留 `resources/**` 和原生模块 `better-sqlite3`；Linux 目标限定为 AppImage/snap/deb；发布 provider 为 generic（指向示例 URL）。
- **Python 构建**：`pyproject.toml` 指定 `build-backend = "uv_build"`，并通过 `[dependency-groups]` 将 `pytest`、`pytest-asyncio`、`ruff` 归入 dev 组，避免污染生产依赖。

## 4. 约定与约束

- **必须使用 pnpm 11+**：根 `package.json` 的 `devEngines.packageManager` 强制要求 pnpm `^11.17.0`，不满足时会触发自动下载。
- **Python 版本锁定**：`.python-version` 固定为 `3.13`，配合 `uv run --project services/agent-runtime --locked` 保证依赖与解释器一致。
- **工作区范围固定**：`pnpm-workspace.yaml` 仅收录 `apps/*`、`packages/*`、`services/*` 三类目录，新增模块需遵循此命名空间。
- **允许/禁止的 Node 构建**：`allowBuilds` 显式允许 `electron`、`esbuild`、`electron-winstaller`，禁用 `better-sqlite3` 的原生编译（运行时再处理）。
- **Electron 原生模块例外**：`electron-builder.yml` 中 `asarUnpack` 明确列出 `node_modules/better-sqlite3/**`，说明该原生模块不被打入 asar。
- **测试路径约定**：Python 测试集中在 `services/agent-runtime/tests`，由 `[tool.pytest.ini_options].testpaths` 指定；TS 测试通过 Vitest 在各自 workspace 内运行。
- **Lint/格式化统一入口**：根 scripts 提供 `lint:ts`、`lint:py`、`fix:py`，开发者应通过根脚本而非直接调用子模块命令来保持一致性。

当前仓库未包含 CI/CD 配置文件（如 GitHub Actions、Jenkinsfile 等），也没有 Makefile/Dockerfile；构建与发布完全通过本地 pnpm/uv 脚本驱动。