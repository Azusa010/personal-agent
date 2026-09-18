---
name: repowiki-incremental-update
description: repowiki 的存放位置与增量更新流程——锚点校验脚本已入库，锚点必须整条链接一起改
metadata:
  node_type: memory
  type: project
  originSessionId: sess_5a088737-31bb-494f-b8e0-95199e471b4f
---

PersonalAgent 的代码库 wiki（Qoder repowiki）位于 **`.repowiki/`**：`zh/content/` 是主题 wiki 文档，`knowledge/zh/` 是知识卡与 `_index.yaml`（模块→源文件映射；目前只登记根模块），`zh/meta/repowiki-metadata.json` 是 Qoder 的加密缓存。2026-09-15 从 `.qoder/repowiki` 迁出改名并纳入 git；`.qoder/` 仍被 `.gitignore` 忽略（见 [[gitignore-untracked-convention]]）。

增量更新流程（2026-09-16 TASK-026 / TASK-029 实操过两次）：

1. 定位基准：上一次 `docs(repowiki)` 提交（`git log --oneline -- .repowiki`）。TASK-026 基准 `ae99448`；TASK-029 基准 `db3a21f`；TASK-030 基准 `af4a837`。
2. `git log --stat <基准>..HEAD` 列增量，按主题映射到叶文档。正文是 Qoder 风格：`<cite>` 引用块 + `## 目录` + mermaid + 「章节来源」锚点 `- [path:起-止](file://path#L起-L止)`。
3. **锚点是「显示文本 + 链接目标」两处**，必须整条链接一起替换；只改 `file://` 那一半会做出显示与目标不一致的锚。
4. **行号位移批量重锚**：`node .repowiki/tools/reanchor.mjs <base-rev> [--write]`。注意：`--write` 相对 `<base>` 算位移，**同一 base 只跑一次**。
5. **一轮里分多次提交时的基准选择（TASK-029 新经验）**：如果代码提交后还有后续提交（如又改了 AGENTS.md / 删了资源文件），不要重跑原 base（会把已改好的锚点再推一遍）；**用「上一轮 reanchor 对应的 HEAD」当第二轮的 base**，位移增量就是两轮间的新提交。TASK-029 用了 `db3a21f`（第一轮）→ `314538f`（第二轮）。
6. **人工项（reanchor 报「首尾行对不上」）要按语义重定位，不能只看 check-anchors**：check-anchors 只查结构（越界/缺失/畸形/显示与目标不一致），查不出语义错位。常见三类：① 整文件引用（`1-<旧总行数>`）改成新总行数+1；② 源文件被**整份重写**（electron-builder.yml 那轮 30 条）按新内容重定区间；③ 指向已删除段落的锚点，改指现存构造或整份引用。
7. 全 wiki 锚点校验（改动后必跑）：`node .repowiki/tools/check-anchors.mjs`。生成器惯例：整文件引用 end = wc -l + 1。
8. 行号必须对**当前工作区**文件成立；不要为未提交功能写内容。
9. 提交单独一条：`docs(repowiki): TASK-0xx 增量更新（<主题>）`。

坑与硬经验：

- **reanchor 看不见工作区的改动**：`hunksOf` 用的是 `git diff -U0 <base> HEAD`，未提交的改动不产生 hunk → 位移恒等，工具不报错也不改写（看着像「未变」）。所以 repowiki 增量必须排在**代码提交之后**；开工前先跑一次 dry-run 就能看出来（TASK-030 实测）。
- **人工项的第三种形态**：区间末行本身被改写过（`}, [])` → `}, [statusPollKey]`），首尾比对必然不认。按构造语义给新行号即可，别当成错位——TASK-030 的 5 条 App.tsx 锚点都是这一种。
- wiki 里可能存在指向**不在 git 里的文件**的锚点（如 `apps/desktop/.gitignore`——本机存在但被全局 ignore 规则挡在库外）。这类锚点对 clone 的读者是死链，发现后删掉或改指库内文件。
- Windows/Git Bash：`perl -pi` 打不开含中文路径，批量替换用 Node 脚本或 Read/Edit 工具；文档为 LF。
- 批量替换脚本放 `.pytest_tmp/`（已忽略）跑，不入库。

TASK-026 那轮动了 22 份文档 + 新增 `.repowiki/tools/`；TASK-029 那轮动了 41 份（自动改写 423 条锚点 + 人工重定位），主要把「venv python」改成运行时三布局、重写部署发布.md、清掉 mac/linux/publish 的过时描述；TASK-030 那轮动了 55 份（913 条自动 + 5 条人工 + 新增 23 条锚点），内容增量落在 5 篇：桌面应用/IPC 通信（模型设置通道）、桌面应用/主进程架构（env 注入与 restartRuntime）、AI 运行时/模型管理（配置来源与优先级）、数据存储（模型设置文件）、用户界面（SettingsDialog）。