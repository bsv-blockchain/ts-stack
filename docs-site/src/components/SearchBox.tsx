import { useState, useCallback, useRef, useEffect } from 'react'
import styles from './SearchBox.module.css'

interface SearchResult {
  url: string
  meta: { title?: string }
  excerpt: string
}

interface PagefindResult {
  url: string
  meta: () => Promise<{ title?: string }>
  excerpt: () => Promise<string>
}

interface Pagefind {
  search: (query: string) => Promise<{ results: PagefindResult[] }>
}

let pagefindPromise: Promise<Pagefind> | null = null

function loadPagefind(): Promise<Pagefind> {
  if (!pagefindPromise) {
    pagefindPromise = import(/* @vite-ignore */ '/_pagefind/pagefind.js') as Promise<Pagefind>
  }
  return pagefindPromise
}

export default function SearchBox() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return }
    const pf = await loadPagefind()
    const { results: raw } = await pf.search(q)
    const top = raw.slice(0, 8)
    const resolved = await Promise.all(
      top.map(async r => ({
        url: r.url,
        meta: await r.meta(),
        excerpt: await r.excerpt(),
      }))
    )
    setResults(resolved)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => search(query), 150)
    return () => clearTimeout(timer)
  }, [query, search])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === '/') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  return (
    <div className={styles.root} ref={containerRef}>
      <input
        ref={inputRef}
        className={styles.input}
        type="search"
        placeholder="Search docs…"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { setOpen(true); loadPagefind() }}
        aria-label="Search documentation"
        aria-expanded={open && results.length > 0}
      />
      <kbd className={styles.kbd}>⌘K</kbd>
      {open && results.length > 0 && (
        <ul className={styles.dropdown} role="listbox">
          {results.map(r => (
            <li key={r.url} role="option">
              <a
                className={styles.result}
                href={r.url}
                onClick={() => setOpen(false)}
              >
                <span className={styles.resultTitle}>{r.meta.title ?? r.url}</span>
                <span
                  className={styles.resultExcerpt}
                  dangerouslySetInnerHTML={{ __html: r.excerpt }}
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
