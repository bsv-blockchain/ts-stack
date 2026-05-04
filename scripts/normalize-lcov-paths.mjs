#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

const [lcovPath, sourcePrefix] = process.argv.slice(2)

if (lcovPath == null || sourcePrefix == null) {
  console.error('Usage: node scripts/normalize-lcov-paths.mjs <lcov.info> <source-prefix>')
  process.exit(1)
}

const prefix = sourcePrefix.replace(/\\/g, '/').replace(/\/+$/, '')
const content = readFileSync(lcovPath, 'utf8')
const cwd = process.cwd()

const normalizePath = (filePath) => {
  let normalized = filePath.replace(/\\/g, '/')

  if (isAbsolute(normalized)) {
    const relativePath = relative(cwd, normalized).replace(/\\/g, '/')
    if (!relativePath.startsWith('..')) {
      normalized = relativePath
    }
  }

  if (isAbsolute(normalized) || normalized === prefix || normalized.startsWith(`${prefix}/`)) {
    return normalized
  }

  return `${prefix}/${normalized}`.replace(/\/+/g, '/')
}

const normalized = content
  .split(/\r?\n/)
  .map(line => line.startsWith('SF:') ? `SF:${normalizePath(line.slice(3))}` : line)
  .join('\n')

writeFileSync(lcovPath, normalized)
