import type { ReactNode } from 'react'
import type { PageMeta } from '../lib/usePageMeta'
import EditOnGitHub from '../components/EditOnGitHub'
import { NAV } from '../lib/nav'
import { Link, useLocation } from 'react-router-dom'
import styles from './GuideLayout.module.css'

interface Props {
  meta: PageMeta | null
  children: ReactNode
}

export default function GuideLayout({ meta, children }: Readonly<Props>) {
  const { pathname } = useLocation()
  const guideSection = NAV.find(s => s.label === 'Guides')
  const guides = guideSection?.items ?? []
  const idx = guides.findIndex(g => g.href === pathname || pathname.startsWith(g.href))
  const prev = idx > 0 ? guides[idx - 1] : null
  const next = idx >= 0 && idx < guides.length - 1 ? guides[idx + 1] : null

  return (
    <div>
      {children}
      {(prev || next) && (
        <nav className={styles.pagination} aria-label="Guide pagination">
          {prev ? (
            <Link to={prev.href} className={styles.prev}>
              <span className={styles.label}>Previous</span>
              <span className={styles.title}>{prev.label}</span>
            </Link>
          ) : <div />}
          {next && (
            <Link to={next.href} className={styles.next}>
              <span className={styles.label}>Next</span>
              <span className={styles.title}>{next.label}</span>
            </Link>
          )}
        </nav>
      )}
      {meta && <EditOnGitHub file={meta.file} />}
    </div>
  )
}
