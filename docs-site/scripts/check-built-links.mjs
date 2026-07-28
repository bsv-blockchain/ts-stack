#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SITE_BASE,
  assetPathForBuiltUrl,
  isExternalUrl,
  resolveInsideRoot,
  splitUrl
} from './path-policy.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_ROOT = resolve(__dirname, '../dist')
const BASE = SITE_BASE

function walk(dir) {
  const results = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...walk(full))
    } else if (name.endsWith('.html')) {
      results.push(full)
    }
  }
  return results
}

let errors = 0
const attrPattern = /\s(href|src)=["']([^"']+)["']/g

for (const file of walk(DIST_ROOT)) {
  const html = readFileSync(file, 'utf8')
  let match

  while ((match = attrPattern.exec(html)) !== null) {
    const [, attr, rawValue] = match
    if (isExternalUrl(rawValue)) continue

    const { pathname } = splitUrl(rawValue)

    if (attr === 'href' && pathname.endsWith('.md')) {
      console.error(`BUILT LINK USES .md: ${relative(DIST_ROOT, file)} → ${rawValue}`)
      errors++
      continue
    }

    if (
      attr === 'href' &&
      pathname &&
      !pathname.startsWith(BASE) &&
      !pathname.startsWith('/_pagefind/')
    ) {
      console.error(`BUILT LINK IS NOT BASE-ABSOLUTE: ${relative(DIST_ROOT, file)} → ${rawValue}`)
      errors++
      continue
    }

    const assetPath = assetPathForBuiltUrl(pathname)
    if (assetPath?.startsWith('assets/')) {
      const target = resolveInsideRoot(DIST_ROOT, assetPath)
      if (!target || !existsSync(target)) {
        console.error(`MISSING BUILT ASSET: ${relative(DIST_ROOT, file)} → ${rawValue}`)
        errors++
      }
    }
  }
}

if (errors > 0) {
  console.error(`\nBuilt link check failed: ${errors} issue(s)`)
  process.exit(1)
}

console.log(`Built links OK: ${walk(DIST_ROOT).length} HTML files checked`)
