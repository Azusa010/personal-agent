import ts from "typescript";
import type { JsxMountCheckResult } from "./types.ts";

interface Candidate {
  name: string;
  line: number;
  source: string;
}

/**
 * 检查单个 .tsx 源码文本中，是否存在「被 import 了但在 JSX 模版树中从未挂载渲染」的孤岛组件。
 *
 * # Contract:
 * - Input:
 *     - sourceCode: TSX 文件文本内容
 *     - filePath: 源码文件路径（用于生成错误和行号）
 * - Output:
 *     - JsxMountCheckResult: 包含 filePath 以及 unmounted 列表（name, line, source）
 * - Invariants:
 *     1. [仅限 PascalCase 标识符] 只有大写字母开头的局部导入（如 Button, Alert, Card）才视为 React 组件候选；
 *        小写开头的工具函数（如 cn, useState）、纯类型导入（import type）必须被忽略；
 *     2. [仅限本地组件导入] 聚焦以 `./`、`../` 或 `@renderer/`、`@/` 开头的本地导入；
 *     3. [JSX 挂载匹配] 凡是在 AST 中出现过以下任一形式的，均视为已挂载，不得报为孤岛：
 *        - JsxSelfClosingElement (如 `<Button />`)
 *        - JsxOpeningElement (如 `<Button>...</Button>`)
 *        - 复合组件属性访问 (如 `<Dialog.Content />`，此时根标识符 `Dialog` 算作已挂载)
 *     4. [孤岛提取] 凡是在导入列表中且未在 JSX 挂载集合中出现的组件，生成 unmounted 记录。
 * - Boundary conditions:
 *     - 源码没有 JSX 元素或没有本地组件导入时，返回空 unmounted 数组；
 *     - 处理命名导入 (如 `import { Button } from './ui/button'`) 与默认导入 (如 `import Button from './ui/button'`)；
 * - Test file: tests/islands/jsx-mount-checker.test.ts
 */
export function findUnmountedJsxComponents(
  sourceCode: string,
  filePath: string,
): JsxMountCheckResult {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const candidates: Candidate[] = [];
  const mountedTags = new Set<string>();

  function isLocalModule(source: string): boolean {
    return (
      source.startsWith("./") ||
      source.startsWith("../") ||
      source.startsWith("@/") ||
      source.startsWith("@renderer/")
    );
  }

  function isPascalCase(name: string): boolean {
    // React 组件命名规范：PascalCase，以大写字母开头，不含下划线，且含有小写字母（排除 ALL_CAPS 常量）
    return /^[A-Z][a-zA-Z0-9]*$/.test(name) && /[a-z]/.test(name);
  }

  function getRootIdentifier(expr: ts.JsxTagNameExpression): string | null {
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      let curr: ts.Expression = expr;
      while (ts.isPropertyAccessExpression(curr)) {
        curr = curr.expression;
      }
      if (ts.isIdentifier(curr)) {
        return curr.text;
      }
    }
    return null;
  }

  function getLineNumber(node: ts.Node): number {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    return line + 1;
  }

  function visit(node: ts.Node): void {
    // 1. 扫描 import 声明
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";

      // 仅关注本地模块且非纯类型导入
      if (isLocalModule(moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const importClause = node.importClause;
        if (importClause) {
          // 默认导入: import Composer from './Composer'
          if (importClause.name && isPascalCase(importClause.name.text)) {
            candidates.push({
              name: importClause.name.text,
              line: getLineNumber(importClause.name),
              source: moduleSpecifier,
            });
          }

          // 命名导入或命名空间导入
          if (importClause.namedBindings) {
            if (ts.isNamedImports(importClause.namedBindings)) {
              for (const element of importClause.namedBindings.elements) {
                if (element.isTypeOnly) continue;
                const localName = element.name.text;
                if (isPascalCase(localName)) {
                  candidates.push({
                    name: localName,
                    line: getLineNumber(element),
                    source: moduleSpecifier,
                  });
                }
              }
            } else if (ts.isNamespaceImport(importClause.namedBindings)) {
              const nsName = importClause.namedBindings.name.text;
              if (isPascalCase(nsName)) {
                candidates.push({
                  name: nsName,
                  line: getLineNumber(importClause.namedBindings),
                  source: moduleSpecifier,
                });
              }
            }
          }
        }
      }
    }

    // 2. 扫描 JSX 元素挂载（包含自闭合标签与成对标签）
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const rootId = getRootIdentifier(node.tagName);
      if (rootId) {
        mountedTags.add(rootId);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // 3. 计算未在 JSX 挂载的孤岛组件
  const unmounted = candidates
    .filter((c) => !mountedTags.has(c.name))
    .map((c) => ({
      name: c.name,
      line: c.line,
      source: c.source,
    }));

  return {
    filePath,
    unmounted,
  };
}
