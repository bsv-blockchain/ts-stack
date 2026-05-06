import type { ReactNode } from 'react'
import type { PageMeta } from '../lib/usePageMeta'
import EditOnGitHub from '../components/EditOnGitHub'

interface Props {
  meta: PageMeta | null
  children: ReactNode
}

export default function SpecLayout({ meta, children }: Readonly<Props>) {
  return (
    <div>
      {children}
      {meta && <EditOnGitHub file={meta.file} />}
    </div>
  )
}
