#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

const EXCLUDED_SOURCE_PATTERNS = [
  /(?:^|\/)__tests__(?:\/|$)/,
  /(?:^|\/)tests?(?:\/|$)/,
  /\.(?:spec|test)\.[cm]?[jt]sx?$/,
  // Build and test configuration is never instrumented, so requiring it in
  // LCOV is unsatisfiable: a package that adds or edits jest.config.cjs,
  // vitest.config.ts or similar could never clear this gate.
  /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/
]

function normalizedPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

function isGovernedSource(file) {
  return (
    file.startsWith('packages/') &&
    /\.[cm]?[jt]sx?$/.test(file) &&
    !EXCLUDED_SOURCE_PATTERNS.some(pattern => pattern.test(file))
  )
}

function governedDiffFile(line) {
  const target = line.slice(4)
  if (target === '/dev/null') return undefined
  const file = normalizedPath(target.replace(/^b\//, ''))
  return isGovernedSource(file) ? file : undefined
}

function addChangedHunkLines(line, changedLines) {
  const match = /\+(\d+)(?:,(\d+))?/.exec(line)
  if (!match) return
  const start = Number(match[1])
  const count = match[2] === undefined ? 1 : Number(match[2])
  for (let offset = 0; offset < count; offset++) changedLines.add(start + offset)
}

export function changedLinesFromDiff(diff) {
  const changed = new Map()
  let file
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = governedDiffFile(line)
      if (file && !changed.has(file)) changed.set(file, new Set())
      continue
    }
    if (!file || !changed.has(file) || !line.startsWith('@@ ')) continue
    addChangedHunkLines(line, changed.get(file))
  }
  return changed
}

function coverageFile(coverage, source) {
  const normalized = normalizedPath(source)
  if (!coverage.has(normalized)) {
    coverage.set(normalized, { lines: new Map(), branches: new Map() })
  }
  return coverage.get(normalized)
}

export function mergeLcov(texts) {
  const coverage = new Map()
  for (const text of texts) {
    let current
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('SF:')) {
        current = coverageFile(coverage, line.slice(3))
      } else if (current && line.startsWith('DA:')) {
        const [lineNumber, hits] = line.slice(3).split(',')
        const key = Number(lineNumber)
        current.lines.set(key, Math.max(current.lines.get(key) ?? 0, Number(hits)))
      } else if (current && line.startsWith('BRDA:')) {
        const [lineNumber, block, branch, taken] = line.slice(5).split(',')
        const key = `${lineNumber}:${block}:${branch}`
        const hits = taken === '-' ? 0 : Number(taken)
        current.branches.set(key, Math.max(current.branches.get(key) ?? 0, hits))
      } else if (line === 'end_of_record') {
        current = undefined
      }
    }
  }
  return coverage
}

export function evaluatePatchCoverage(changed, coverage) {
  const misses = []
  const missingFiles = []
  const points = { covered: 0, total: 0 }
  for (const [file, lines] of changed) {
    const fileCoverage = coverage.get(file)
    if (!fileCoverage) {
      missingFiles.push(file)
      continue
    }
    addFileCoverage(file, lines, fileCoverage, points, misses)
  }
  return {
    ...points,
    percent: points.total === 0 ? 100 : (points.covered / points.total) * 100,
    misses,
    missingFiles
  }
}

function addFileCoverage(file, lines, fileCoverage, points, misses) {
  for (const line of [...lines].sort((left, right) => left - right)) {
    addLineCoverage(file, line, fileCoverage, points, misses)
    addBranchCoverage(file, line, fileCoverage, points, misses)
  }
}

function addLineCoverage(file, line, fileCoverage, points, misses) {
  if (!fileCoverage.lines.has(line)) return
  points.total++
  if (fileCoverage.lines.get(line) > 0) points.covered++
  else misses.push(`${file}:${line} (line)`)
}

function addBranchCoverage(file, line, fileCoverage, points, misses) {
  for (const [key, hits] of fileCoverage.branches) {
    if (!key.startsWith(`${line}:`)) continue
    points.total++
    if (hits > 0) points.covered++
    else misses.push(`${file}:${line} (branch ${key.slice(String(line).length + 1)})`)
  }
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

function lcovFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...lcovFiles(entryPath))
    else if (entry.isFile() && entry.name.endsWith('.lcov.info')) files.push(entryPath)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

async function main(arguments_) {
  const base = option(arguments_, '--base')
  const directory = option(arguments_, '--lcov-directory')
  const target = Number(option(arguments_, '--target') ?? 90)
  if (!base || !directory || !Number.isFinite(target) || target <= 0 || target > 100) {
    throw new Error('Usage: patch-coverage.mjs --base <sha> --lcov-directory <path> [--target 90]')
  }
  const diff = execFileSync(
    '/usr/bin/git',
    ['diff', '--unified=0', '--diff-filter=AMRC', `${base}...HEAD`, '--', 'packages'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  )
  const changed = changedLinesFromDiff(diff)
  const directoryPath = path.resolve(directory)
  const files = fs.existsSync(directoryPath) ? lcovFiles(directoryPath) : []
  if (changed.size > 0 && files.length === 0) {
    throw new Error(`Changed production files require LCOV inputs beneath ${directory}`)
  }
  const result = evaluatePatchCoverage(
    changed,
    mergeLcov(files.map(file => fs.readFileSync(file, 'utf8')))
  )
  const summary =
    `Patch coverage ${result.percent.toFixed(2)}% ` +
    `(${result.covered}/${result.total} changed line/branch points; target ${target.toFixed(2)}%).`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Repository patch coverage\n\n${summary}\n`
    )
  }
  if (result.missingFiles.length > 0) {
    throw new Error(
      `${summary}\nChanged production files absent from LCOV:\n${result.missingFiles.join('\n')}`
    )
  }
  if (result.percent + Number.EPSILON < target) {
    throw new Error(`${summary}\nUncovered:\n${result.misses.join('\n')}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
