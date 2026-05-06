import type { ReactNode } from 'react'
import type { PageMeta } from '../lib/usePageMeta'
import EditOnGitHub from '../components/EditOnGitHub'
import styles from './MetaLayout.module.css'

interface Props {
  meta: PageMeta | null
  children: ReactNode
}

export default function MetaLayout({ meta, children }: Readonly<Props>) {
  return (
    <div className={styles.root}>
      {children}
      {meta && <EditOnGitHub file={meta.file} />}
    </div>
  )
}
