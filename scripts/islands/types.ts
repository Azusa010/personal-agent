/**
 * 孤岛代码与死代码检测核心数据结构契约定义
 */

export type IslandIssueKind =
  | "unused_file" // 未引用的孤立文件
  | "unused_export" // 未被生产入口消费的导出（函数/类/常量）
  | "unused_type" // 未使用的类型/接口定义
  | "unmounted_jsx" // 已 import 但从未在 JSX 树中挂载渲染的组件
  | "python_dead_code" // Python 运行时中的死代码（函数/类/属性）
  | "unused_dependency"; // 未使用的 npm / pip 依赖

export interface IslandIssue {
  kind: IslandIssueKind;
  file: string; // 相对路径或绝对路径
  line?: number; // 所在行号（1-indexed）
  col?: number; // 所在列号
  symbolName: string; // 被检测出的符号名或文件名（如 'Table', 'cleanOldData'）
  detail: string; // 说明信息（如 '在 App.tsx 中 import，但从未在 JSX 树中挂载渲染'）
  language: "typescript" | "python";
}

export interface IslandReport {
  timestamp: string;
  totalIssues: number;
  tsCount: number;
  pyCount: number;
  issues: IslandIssue[];
}

export interface JsxImportCandidate {
  name: string; // 导入的组件符号名（如 'Badge', 'Table'）
  line: number; // 导入所在行号
  source: string; // 导入路径（如 './ui/badge'）
}

export interface JsxMountCheckResult {
  filePath: string;
  unmounted: Array<{
    name: string;
    line: number;
    source: string;
  }>;
}
