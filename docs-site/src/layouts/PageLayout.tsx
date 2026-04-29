import type { ReactNode } from 'react'
import { usePageMeta } from '../lib/usePageMeta'
import PackageLayout from './PackageLayout'
import SpecLayout from './SpecLayout'
import GuideLayout from './GuideLayout'
import MetaLayout from './MetaLayout'

interface Props {
  children: ReactNode
}

export default function PageLayout({ children }: Props) {
  const meta = usePageMeta()
  const kind = meta?.kind ?? 'meta'

  switch (kind) {
    case 'package':
      return <PackageLayout meta={meta}>{children}</PackageLayout>
    case 'spec':
      return <SpecLayout meta={meta}>{children}</SpecLayout>
    case 'guide':
      return <GuideLayout meta={meta}>{children}</GuideLayout>
    case 'meta':
    case 'about':
    case 'reference':
    case 'conformance':
    case 'infra':
    case 'domain':
    default:
      return <MetaLayout meta={meta}>{children}</MetaLayout>
  }
}
