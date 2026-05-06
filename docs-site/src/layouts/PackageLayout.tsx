import type { ReactNode } from 'react'
import type { PageMeta } from '../lib/usePageMeta'
import EditOnGitHub from '../components/EditOnGitHub'
import styles from './PackageLayout.module.css'

interface Props {
  meta: PageMeta | null
  children: ReactNode
}

export default function PackageLayout({ meta, children }: Readonly<Props>) {
  const npm = meta?.npm
  const version = meta?.version
  const apiSlug = npm?.replace('@bsv/', '')

  return (
    <div className={styles.root}>
      {(npm || version) && (
        <div className={styles.meta}>
          {npm && (
            <span className={styles.badge}>
              <span className={styles.badgeKey}>npm</span>
              <span className={styles.badgeVal}>{npm}</span>
            </span>
          )}
          {version && version !== 'n/a' && (
            <span className={styles.badge}>
              <span className={styles.badgeKey}>v</span>
              <span className={styles.badgeVal}>{version}</span>
            </span>
          )}
          {meta?.status && meta.status !== 'stable' && (
            <span className={styles.badge + ' ' + styles[meta.status as string]}>
              {meta.status}
            </span>
          )}
          {apiSlug && (
            <a
              className={styles.apiLink}
              href={`https://bsv-blockchain.github.io/ts-stack/api/${apiSlug}/`}
              target="_blank"
              rel="noopener noreferrer"
            >
              API reference (TypeDoc) ↗
            </a>
          )}
        </div>
      )}
      {children}
      {meta && <EditOnGitHub file={meta.file} />}
    </div>
  )
}
