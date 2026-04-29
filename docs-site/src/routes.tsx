import { lazy, Suspense, type ComponentType } from 'react'
import type { RouteObject } from 'react-router-dom'
import RootLayout from './layouts/RootLayout'

function page(factory: () => Promise<{ default: ComponentType }>) {
  const Comp = lazy(factory)
  return (
    <Suspense fallback={<div style={{ padding: '2rem', color: 'var(--dev-fg-muted)' }}>Loading…</div>}>
      <Comp />
    </Suspense>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const pages = import.meta.glob(
  ['../../docs/**/*.md', '!../../docs/_internal/**', '!../../docs/_schemas/**'],
  { eager: false }
) as Record<string, () => Promise<{ default: ComponentType }>>

function mdRoute(docPath: string): string {
  return docPath
    .replace('../../docs', '')
    .replace(/\/index\.md$/, '/')
    .replace(/\.md$/, '/')
}

const docRoutes: RouteObject[] = Object.keys(pages).map(key => ({
  path: mdRoute(key),
  element: page(pages[key]),
}))

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      ...docRoutes,
      {
        path: '*',
        element: page(() => import('./pages/404')),
      },
    ],
  },
]
