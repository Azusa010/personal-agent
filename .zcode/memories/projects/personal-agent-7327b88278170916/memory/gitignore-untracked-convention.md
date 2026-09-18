---
name: gitignore-untracked-convention
description: 用户的全局 gitignore 忽略 .gitignore 文件本身，因此本仓 .gitignore 未跟踪——改它只在本机生效
metadata:
  node_type: memory
  type: user
  originSessionId: sess_5a088737-31bb-494f-b8e0-95199e471b4f
---

用户的全局 excludes 文件 `C:/Users/Azusama/.gitignore_global` 第 1 行是 `.gitignore`，即**所有 .gitignore 文件都被全局忽略**。PersonalAgent 仓库的 `.gitignore` 因此未被 git 跟踪（`git ls-files .gitignore` 为空），对它的修改只在本机生效，`git add` 会报 "paths are ignored"。

**How to apply:** 不要擅自 `git add -f .gitignore`；向用户说明改动仅本地生效即可。涉及「让某目录进/出版本管理」的需求时，忽略规则改动无法随仓库分发，必要时提醒用户改全局配置或改用 `.git/info/exclude`。本仓的 `.qoder`→`.repowiki` 迁移即属此类（见 [[repowiki-incremental-update]]）。