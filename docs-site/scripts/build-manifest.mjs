#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { resolve, relative, join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(__dirname, '../../docs')
const OUT = resolve(__dirname, '../src/manifest.json')

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const yaml = match[1]
  const result = {}
  for (const line of yaml.split('\n')) {
    const [key, ...rest] = line.split(':')
    if (!key?.trim()) continue
    let val = rest.join(':').trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
    if (val === 'true') val = true
    if (val === 'false') val = false
    if (val === 'null') val = null
    result[key.trim()] = val
  }
  return result
}

function mdToRoute(relPath) {
  return relPath
    .replace(/\/index\.md$/, '/')
    .replace(/\.md$/, '/')
    .replace(/^([^/])/, '/$1')
}

function walk(dir, base = DOCS_ROOT) {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      entries.push(...walk(full, base))
    } else if (name.endsWith('.md')) {
      const rel = relative(base, full)
      const fm = readFrontmatter(readFileSync(full, 'utf8'))
      entries.push({
        file: rel,
        route: mdToRoute(rel),
        id: fm.id ?? null,
        title: fm.title ?? name.replace('.md', ''),
        kind: fm.kind ?? 'meta',
        domain: fm.domain ?? null,
        version: fm.version ?? null,
        npm: fm.npm ?? null,
        status: fm.status ?? 'stable',
        last_updated: fm.last_updated ?? null,
        tags: [],
      })
    }
  }
  return entries
}

const entries = walk(DOCS_ROOT)
writeFileSync(OUT, JSON.stringify(entries, null, 2))
console.log(`Manifest: ${entries.length} pages → ${OUT}`)
