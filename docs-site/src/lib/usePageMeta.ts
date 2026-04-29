import { useLocation } from 'react-router-dom'
import manifest from '../manifest.json'

export interface PageMeta {
  route: string
  kind: string
  title: string
  npm?: string | null
  version?: string | null
  domain?: string | null
  status?: string | null
  last_updated?: string | null
  file: string
}

const entries = manifest as PageMeta[]

function normalize(p: string) {
  return p.endsWith('/') ? p : p + '/'
}

export function usePageMeta(): PageMeta | null {
  const { pathname } = useLocation()
  return entries.find(m => m.route === normalize(pathname)) ?? null
}

export function getPageMeta(pathname: string): PageMeta | null {
  return entries.find(m => m.route === normalize(pathname)) ?? null
}

export { entries as manifest }
