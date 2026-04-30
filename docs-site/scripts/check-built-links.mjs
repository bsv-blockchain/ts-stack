#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_ROOT = resolve(__dirname, '../dist')
const BASE = '/ts-stack/'

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

function isExternal(value) {
  return /^(?:https?:|data:|mailto:|#|\/\/)/.test(value)
}

function splitUrl(value) {
  const suffixIndex = value.search(/[?#]/)
  if (suffixIndex === -1) return { pathname: value, suffix: '' }
  return {
    pathname: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  }
}

function assetPathForBuiltUrl(pathname) {
  if (pathname.startsWith(BASE)) return pathname.slice(BASE.length)
  if (pathname.startsWith('/assets/')) return pathname.slice(1)
  return null
}

function resolveDistPath(localPath) {
  const full = resolve(DIST_ROOT, decodeURIComponent(localPath))
  const rel = relative(DIST_ROOT, full)
  if (rel.startsWith('..') || rel.startsWith('/')) return null
  return full
}

let errors = 0
const attrPattern = /\s(href|src)=["']([^"']+)["']/g

for (const file of walk(DIST_ROOT)) {
  const html = readFileSync(file, 'utf8')
  let match

  while ((match = attrPattern.exec(html)) !== null) {
    const [, attr, rawValue] = match
    if (isExternal(rawValue)) continue

    const { pathname } = splitUrl(rawValue)

    if (attr === 'href' && pathname.endsWith('.md')) {
      console.error(`BUILT LINK USES .md: ${relative(DIST_ROOT, file)} → ${rawValue}`)
      errors++
      continue
    }

    if (attr === 'href' && pathname && !pathname.startsWith(BASE) && !pathname.startsWith('/_pagefind/')) {
      console.error(`BUILT LINK IS NOT BASE-ABSOLUTE: ${relative(DIST_ROOT, file)} → ${rawValue}`)
      errors++
      continue
    }

    const assetPath = assetPathForBuiltUrl(pathname)
    if (assetPath?.startsWith('assets/')) {
      const target = resolveDistPath(assetPath)
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
