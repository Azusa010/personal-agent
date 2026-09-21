export interface CodeBlockMeta {
  /** 归一化后的小写语言名称，如 'typescript', 'python', 'json'。无语言或未指定时为 '' */
  language: string
}

/**
 * 从 Markdown 代码块的 className 中提取并归一化语言标识符。
 *
 * 常见输入示例：
 * - 'language-typescript' -> 'typescript'
 * - 'language-PYTHON' -> 'python'
 * - 'language-json:config.json' -> 'json' （提取冒号或附加后缀前的语言部分）
 * - 'hljs language-bash active' -> 'bash' （支持混合多个 class）
 * - undefined / '' / 'not-a-lang' -> '' （无合法 language-* 前缀时返回空串）
 *
 * @param className react-markdown 传给 code 标签的 className 属性
 * @returns 包含归一化小写 language 的对象
 */
export function parseCodeBlockMeta(className?: string): CodeBlockMeta {
  if (className === undefined || className.trim() === '') {
    return { language: '' }
  }
  const match = className.match(/language-([a-zA-Z0-9_+#-]+)/)
  if (match) {
    const language = match[1].split(':')[0].toLowerCase().trim()
    return { language }
  }
  return { language: '' }
}
