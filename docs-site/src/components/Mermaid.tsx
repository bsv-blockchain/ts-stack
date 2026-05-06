import { useEffect, useId, useRef, useState } from 'react'
import styles from './Mermaid.module.css'

interface Props {
  code: string
}

export default function Mermaid({ code }: Readonly<Props>) {
  const ref = useRef<HTMLDivElement>(null)
  const renderId = useId().replaceAll(':', '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ref.current) return

    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#16161f',
          primaryTextColor: '#e2e8f0',
          primaryBorderColor: '#2a2a3d',
          lineColor: '#6b7280',
          secondaryColor: '#111119',
          tertiaryColor: '#0c0c14',
          background: '#0c0c14',
          mainBkg: '#16161f',
          nodeBorder: '#2a2a3d',
          clusterBkg: '#111119',
          titleColor: '#e2e8f0',
          edgeLabelBackground: '#16161f',
          attributeBackgroundColorEven: '#111119',
          attributeBackgroundColorOdd: '#16161f',
        },
        fontFamily: "'JetBrains Mono', monospace",
      })

      const id = `mermaid-${renderId}`
      mermaid
        .render(id, code)
        .then(({ svg }) => {
          if (ref.current) ref.current.innerHTML = svg
        })
        .catch(err => setError(String(err)))
    })
  }, [code])

  if (error) {
    return (
      <pre className={styles.error}>
        <code>Mermaid error: {error}</code>
      </pre>
    )
  }

  return <div ref={ref} className={styles.root} aria-label="Diagram" />
}
