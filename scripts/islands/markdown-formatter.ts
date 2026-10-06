import type { IslandIssue, IslandReport } from "./types.ts";

/**
 * 将孤岛检测结果转化为清晰的 Markdown 体检报告
 */
export function formatMarkdownReport(
  report: IslandReport,
  repoRoot: string,
): string {
  const tsIssues = report.issues.filter((i) => i.language === "typescript");
  const pyIssues = report.issues.filter((i) => i.language === "python");

  const lines: string[] = [
    `# 🏝️ PersonalAgent 孤岛与死代码检测报告`,
    ``,
    `> 生成时间: ${report.timestamp}  `,
    `> 统计摘要: 共发现 **${report.totalIssues}** 处孤岛代码（TypeScript/UI: **${report.tsCount}** 处，Python: **${report.pyCount}** 处）`,
    ``,
    `---`,
    ``,
    `## 1. TypeScript / React UI 孤岛清单 (${tsIssues.length})`,
    ``,
  ];

  if (tsIssues.length === 0) {
    lines.push(`✅ 未发现 TypeScript / React 孤岛或死代码。`);
  } else {
    lines.push(`| 严重类型 | 符号 / 组件名 | 文件位置 | 说明 |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const issue of tsIssues) {
      const typeLabel = renderTypeLabel(issue.kind);
      const link = `[${issue.file}${issue.line ? `:${issue.line}` : ""}](file:///${repoRoot.replace(/\\/g, "/")}/${issue.file.replace(/\\/g, "/")}${issue.line ? `#L${issue.line}` : ""})`;
      lines.push(
        `| ${typeLabel} | \`${issue.symbolName}\` | ${link} | ${issue.detail} |`,
      );
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## 2. Python Agent 运行时死代码清单 (${pyIssues.length})`);
  lines.push(``);

  if (pyIssues.length === 0) {
    lines.push(`✅ 未发现 Python 运行时死代码。`);
  } else {
    lines.push(`| 严重类型 | 符号 / 函数名 | 文件位置 | 说明 |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const issue of pyIssues) {
      const typeLabel = renderTypeLabel(issue.kind);
      const link = `[${issue.file}${issue.line ? `:${issue.line}` : ""}](file:///${repoRoot.replace(/\\/g, "/")}/${issue.file.replace(/\\/g, "/")}${issue.line ? `#L${issue.line}` : ""})`;
      lines.push(
        `| ${typeLabel} | \`${issue.symbolName}\` | ${link} | ${issue.detail} |`,
      );
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`*本报告由 \`pnpm check:islands\` 自动扫描生成。*`);
  lines.push(``);

  return lines.join("\n");
}

function renderTypeLabel(kind: IslandIssue["kind"]): string {
  switch (kind) {
    case "unmounted_jsx":
      return "⚠️ [JSX未挂载]";
    case "unused_file":
      return "🔴 [孤立文件]";
    case "unused_export":
      return "🟡 [未用导出]";
    case "unused_type":
      return "⚪ [未用类型]";
    case "python_dead_code":
      return "🐍 [Python死代码]";
    case "unused_dependency":
      return "📦 [冗余依赖]";
    default:
      return "🔍 [孤岛代码]";
  }
}
