#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeUtf8FileAtomic } from '../../scripts/file-system.mjs'

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
  const children = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const child of children) {
    const full = join(dir, child.name)
    if (child.isDirectory()) {
      if (child.name.startsWith('_') || child.name.startsWith('.')) continue
      entries.push(...walk(full, base))
    } else if (child.isFile() && child.name.endsWith('.md')) {
      const rel = relative(base, full)
      const fm = readFrontmatter(readFileSync(full, 'utf8'))
      entries.push({
        file: rel,
        route: mdToRoute(rel),
        id: fm.id ?? null,
        title: fm.title ?? child.name.replace('.md', ''),
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
writeUtf8FileAtomic(OUT, JSON.stringify(entries, null, 2))
console.log(`Manifest: ${entries.length} pages → ${OUT}`)
