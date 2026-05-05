#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

const [lcovPath, sourcePrefix] = process.argv.slice(2)

if (lcovPath == null || sourcePrefix == null) {
  console.error('Usage: node scripts/normalize-lcov-paths.mjs <lcov.info> <source-prefix>')
  process.exit(1)
}

const slashify = (value) => value.replaceAll('\\', '/')

const trimTrailingSlashes = (value) => {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end -= 1
  return value.slice(0, end)
}

const trimLeadingSlashes = (value) => {
  let start = 0
  while (start < value.length && value[start] === '/') start += 1
  return value.slice(start)
}

const prefix = trimTrailingSlashes(slashify(sourcePrefix))
const content = readFileSync(lcovPath, 'utf8')
const cwd = process.cwd()

const normalizePath = (filePath) => {
  let normalized = slashify(filePath)

  if (isAbsolute(normalized)) {
    const relativePath = slashify(relative(cwd, normalized))
    if (!relativePath.startsWith('..')) {
      normalized = relativePath
    }
  }

  if (isAbsolute(normalized) || normalized === prefix || normalized.startsWith(`${prefix}/`)) {
    return normalized
  }

  return `${prefix}/${trimLeadingSlashes(normalized)}`
}

const normalized = content
  .split('\n')
  .map(rawLine => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    return line.startsWith('SF:') ? `SF:${normalizePath(line.slice(3))}` : line
  })
  .join('\n')

writeFileSync(lcovPath, normalized)
