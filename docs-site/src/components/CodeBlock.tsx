import { isValidElement, lazy, Suspense, useState, type ReactNode } from 'react'
import '../styles/code.css'

const Mermaid = lazy(() => import('./Mermaid'))

interface Props {
  children?: ReactNode
  [key: string]: unknown
}

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children)
  return ''
}

export default function CodeBlock({ children, ...rest }: Readonly<Props>) {
  const [copied, setCopied] = useState(false)

  const codeEl = isValidElement<{ children?: ReactNode; className?: string }>(children)
    ? children.props
    : undefined
  const rawCode = textContent(codeEl?.children ?? children)
  // Shiki strips language-xxx from <code> but we inject data-language on <pre> via transformer
  const lang =
    (rest['data-language'] as string | undefined) ??
    codeEl?.className?.replace('language-', '') ??
    'text'

  if (lang === 'mermaid') {
    return (
      <Suspense
        fallback={
          <pre className="code-block">
            <code>{rawCode}</code>
          </pre>
        }
      >
        <Mermaid code={rawCode} />
      </Suspense>
    )
  }

  function copy() {
    navigator.clipboard.writeText(rawCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang}</span>
        <button
          className={'code-copy-btn' + (copied ? ' copied' : '')}
          onClick={copy}
          aria-label="Copy code"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre {...(rest as object)}>{children}</pre>
    </div>
  )
}
