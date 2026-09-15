---
kind: frontend_style
name: 基于 shadcn/ui + Tailwind v4 的 Electron 前端样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - apps/desktop/components.json
    - apps/desktop/src/renderer/src/assets/app.css
    - apps/desktop/src/renderer/src/lib/utils.ts
    - apps/desktop/src/renderer/src/components/ui/button.tsx
    - apps/desktop/package.json
---

## 1. 系统概览

桌面端渲染进程（`apps/desktop/src/renderer`）采用 **React + TypeScript** 构建，样式栈为：
- **Tailwind CSS v4**（通过 `@tailwindcss/vite` 插件集成到 Vite/Electron-Vite）
- **shadcn/ui**（`style: "new-york"`，基于 Radix UI 无头组件）
- **CSS 变量主题**（亮/暗两套色板，通过 `.dark` class 切换）
- **class-variance-authority (CVA)** 定义组件变体
- **clsx + tailwind-merge** 合并 className
- **tw-animate-css** 提供动画

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `apps/desktop/components.json` | shadcn/ui 配置：风格 new-york、baseColor zinc、图标库 lucide、路径别名 `@renderer/components/ui` 等 |
| `apps/desktop/src/renderer/src/assets/app.css` | 全局样式入口：`@import 'tailwindcss'`、`@import 'tw-animate-css'`、自定义 `dark` 变体、`@theme inline` 语义化 token、`:root` 与 `.dark` 两套 CSS 变量 |
| `apps/desktop/src/renderer/src/lib/utils.ts` | `cn(...inputs)` 工具函数，统一使用 `twMerge(clsx(...))` 合并类名 |
| `apps/desktop/src/renderer/src/components/ui/*.tsx` | shadcn 生成的基础 UI 组件（button、card、dialog、input、table 等），均用 CVA 声明 variant/size |
| `apps/desktop/package.json` | 依赖声明：`tailwindcss ^4.3.3`、`radix-ui ^1.6.7`、`class-variance-authority ^0.7.1`、`clsx ^2.1.1`、`tailwind-merge ^3.6.0`、`lucide-react ^1.45.0`、`tw-animate-css ^1.4.0` |

## 3. 架构与约定

### 3.1 设计令牌（Design Tokens）
- 所有颜色、圆角、字体均通过 CSS 变量暴露，集中在 `app.css` 的 `:root`（亮色）和 `.dark`（暗色）块中。
- 通过 `@theme inline { --color-* }` 把 CSS 变量映射为 Tailwind 语义色（`background`、`foreground`、`primary`、`destructive`、`success`、`warning`、`info` 等），业务组件只引用语义色，不写死十六进制值。
- 额外引入三组产品语义色 `--color-success` / `--color-warning` / `--color-info`，替代原模板中的硬编码 `.outcome-success/.outcome-failed/.outcome-error` 类。
- 圆角通过 `--radius-sm/md/lg/xl` 计算派生自 `--radius`。

### 3.2 暗色模式策略
- 自定义 `@custom-variant dark (&:is(.dark *));`，使 `dark:` 前缀匹配 `<html class="dark">` 下的后代，而非仅跟随系统 `prefers-color-scheme`。
- 亮色主题实际不使用（index.html 始终给 `<html>` 加 `dark`），但 token 仍定义完整，避免 shadcn 组件内未带 `dark:` 分支时回退到 Tailwind 默认灰。

### 3.3 组件样式组织
- 基础 UI 组件位于 `src/renderer/src/components/ui/`，由 shadcn 生成并维护。
- 每个组件用 CVA 声明 `variants`（如 button 的 `default/destructive/outline/secondary/ghost/link` 及 `xs/sm/lg/icon-*` size），并通过 `data-slot`、`data-variant`、`data-size` 属性标记，便于测试与调试。
- 组件 className 一律经 `cn(buttonVariants({ variant, size, className }))` 合并，允许调用方覆盖。
- 图标统一来自 `lucide-react`。

### 3.4 响应式策略
- 完全基于 Tailwind 的断点与修饰符（如 `sm:`、`md:`、`lg:` 等），未见媒体查询或独立媒体查询文件。
- 布局通过 flex/grid + Tailwind 原子类组合实现。

## 4. 约定与约束

- **禁止在组件中直接写死颜色/尺寸**：应使用 `bg-primary`、`text-foreground`、`rounded-md`、`h-9` 等语义化 Tailwind 类；具体数值集中在 `app.css` 的 CSS 变量中。
- **className 合并必须走 `cn()`**：`lib/utils.ts` 是唯一导出入口，确保 `clsx` 条件拼接与 `tailwind-merge` 冲突消解。
- **暗色分支统一用 `dark:` 前缀**：由 `@custom-variant dark` 驱动，不要手写 `@media (prefers-color-scheme: dark)`。
- **新增 UI 组件优先复用 shadcn 基础组件**：通过 `components.json` 的 `ui` 别名导入，保持视觉一致。
- **主题扩展通过修改 `app.css` 的 `:root` / `.dark` 变量完成**：不要在业务组件里重新定义同名变量。
- **字体与基础排版在 `@layer base` 中集中设置**：`font-sans`、`bg-background`、`text-foreground`、`user-select: text` 等。
- **Electron 特定行为**：`body` 显式开启 `user-select: text`（覆盖 Electron 模板默认的 `none`），以便复制 taskId、路径、错误码。