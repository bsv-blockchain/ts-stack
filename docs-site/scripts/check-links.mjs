#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { resolve, join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(__dirname, '../../docs')

function walk(dir) {
  const results = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      results.push(...walk(full))
    } else if (name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

const files = walk(DOCS_ROOT)
let errors = 0

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  const dir = dirname(file)

  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g
  let match
  while ((match = linkPattern.exec(content)) !== null) {
    const href = match[2].split('#')[0].split('?')[0]
    if (!href) continue
    if (href.startsWith('http') || href.startsWith('//') || href.startsWith('mailto:')) continue
    if (!href.endsWith('.md') && !href.includes('/')) continue
    if (!href.endsWith('.md')) continue

    const target = resolve(dir, href)
    if (!existsSync(target)) {
      console.error(`BROKEN LINK: ${relative(DOCS_ROOT, file)} → ${href}`)
      errors++
    }
  }
}

if (errors > 0) {
  console.error(`\nLink check failed: ${errors} broken link(s)`)
  process.exit(1)
} else {
  console.log(`Links OK: ${files.length} files checked`)
}
