import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { parseCodeBlockMeta } from '../lib/markdown'

export interface MarkdownContentProps {
  content: string
  className?: string
}

function CodeBlock({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const { language } = parseCodeBlockMeta(className)
  const codeString = String(children).replace(/\n$/, '')

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(codeString)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板异常静默兜底
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-black/20 dark:bg-black/30">
      <div className="flex h-7 items-center justify-between border-b border-border/50 bg-secondary/30 px-3 text-[11px] font-mono text-muted-foreground select-none">
        <span>{language || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title="复制代码"
          aria-label="复制代码"
        >
          {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-foreground/90">
        <code>{children}</code>
      </pre>
    </div>
  )
}

export function MarkdownContent({
  content,
  className = ''
}: MarkdownContentProps): React.JSX.Element {
  return (
    <div className={`text-[13px] leading-relaxed text-foreground ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: codeClassName, children, ...props }) {
            // 没有类名且不包含换行的代码视为行内代码
            const isInline = !codeClassName && !String(children).includes('\n')
            if (isInline) {
              return (
                <code
                  className="rounded bg-secondary/80 px-1 py-0.5 font-mono text-[11.5px] text-foreground border border-border/40"
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return <CodeBlock className={codeClassName}>{children}</CodeBlock>
          },
          pre({ children }) {
            // 外层交给 CodeBlock 统一处理容器与头部，此处直接透传 children 避免双重 pre
            return <>{children}</>
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity font-medium"
              >
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="my-2 max-w-full overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-left text-xs">{children}</table>
              </div>
            )
          },
          th({ children }) {
            return (
              <th className="border-b border-border bg-secondary/50 px-3 py-1.5 font-medium text-foreground">
                {children}
              </th>
            )
          },
          td({ children }) {
            return (
              <td className="border-b border-border/40 px-3 py-1.5 text-muted-foreground last:border-b-0">
                {children}
              </td>
            )
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-border/80 pl-3 my-2 text-muted-foreground italic">
                {children}
              </blockquote>
            )
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 my-1.5 space-y-1">{children}</ul>
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 my-1.5 space-y-1">{children}</ol>
          },
          p({ children }) {
            return <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
          },
          h1({ children }) {
            return (
              <h1 className="text-[15px] font-semibold mt-3 mb-1 text-foreground">{children}</h1>
            )
          },
          h2({ children }) {
            return (
              <h2 className="text-[14px] font-semibold mt-2.5 mb-1 text-foreground">{children}</h2>
            )
          },
          h3({ children }) {
            return (
              <h3 className="text-[13px] font-semibold mt-2 mb-1 text-foreground">{children}</h3>
            )
          },
          hr() {
            return <hr className="my-3 border-border/50" />
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
