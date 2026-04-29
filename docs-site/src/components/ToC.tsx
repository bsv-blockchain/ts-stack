import { useEffect, useState } from 'react'
import styles from './ToC.module.css'

interface Heading {
  id: string
  text: string
  level: number
}

export default function ToC() {
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState<string>('')

  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLHeadingElement>('.prose h2, .prose h3')
    )
    setHeadings(
      els.map(el => ({
        id: el.id,
        text: el.textContent ?? '',
        level: parseInt(el.tagName.slice(1)),
      }))
    )
  }, [])

  useEffect(() => {
    if (!headings.length) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.find(e => e.isIntersecting)
        if (visible) setActive(visible.target.id)
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    )
    headings.forEach(h => {
      const el = document.getElementById(h.id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [headings])

  if (!headings.length) return null

  return (
    <nav className={styles.toc} aria-label="On this page">
      <span className={styles.label}>On this page</span>
      <ul className={styles.list}>
        {headings.map(h => (
          <li key={h.id} className={styles['level' + h.level]}>
            <a
              href={'#' + h.id}
              className={styles.link + (active === h.id ? ' ' + styles.active : '')}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
