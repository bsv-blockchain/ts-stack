import { lazy, Suspense, type ComponentType } from 'react'
import type { RouteObject } from 'react-router'
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

const pageEntries = Object.entries(pages).sort(([left], [right]) => left.localeCompare(right))

export const docPaths = pageEntries.map(([key]) => mdRoute(key))

// Child paths are relative to the root route; the basename is supplied by each
// browser or static-rendering router.
const docRoutes: RouteObject[] = pageEntries.map(([key, loadPage]) => {
  const absPath = mdRoute(key)
  if (absPath === '/') {
    return { index: true, element: page(loadPage) } as RouteObject
  }
  return { path: absPath.slice(1), element: page(loadPage) }
})

export const routes: RouteObject[] = [
  {
    path: '/',
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
