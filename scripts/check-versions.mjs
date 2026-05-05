#!/usr/bin/env node
/**
 * check-versions.mjs
 *
 * Reports all workspace cross-references that are out of date.
 * Exit code 1 if any stale refs found (useful in CI).
 *
 * Usage:
 *   node scripts/check-versions.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const output = execSync('pnpm -r ls --json --depth 0', { cwd: ROOT }).toString()
const pkgList = JSON.parse(output)

const workspaceMap = {}
for (const pkg of pkgList) {
  if (pkg.name && pkg.version) {
    workspaceMap[pkg.name] = pkg.version
  }
}

function parseVersion (version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

function compareVersion (a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function caretUpperBound (version) {
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0 }
  }
  if (version.minor > 0) {
    return { major: 0, minor: version.minor + 1, patch: 0 }
  }
  return { major: 0, minor: 0, patch: version.patch + 1 }
}

function acceptsWorkspaceVersion (range, wsVersion) {
  if (range === 'workspace:*' || range === `^${wsVersion}`) return true
  if (!range.startsWith('^')) return false

  const min = parseVersion(range.slice(1))
  const current = parseVersion(wsVersion)
  if (!min || !current) return false

  return compareVersion(current, min) >= 0 && compareVersion(current, caretUpperBound(min)) < 0
}

let stale = 0

for (const pkg of pkgList) {
  if (!pkg.path) continue
  const jsonPath = resolve(pkg.path, 'package.json')
  let raw
  try {
    raw = readFileSync(jsonPath, 'utf-8')
  } catch {
    continue
  }
  const d = JSON.parse(raw)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!d[field]) continue
    for (const [dep, range] of Object.entries(d[field])) {
      const wsVersion = workspaceMap[dep]
      if (!wsVersion) continue
      if (!acceptsWorkspaceVersion(range, wsVersion)) {
        console.log(`STALE  ${d.name}  ${dep}  ${range}  (current: ${wsVersion})`)
        stale++
      }
    }
  }
}

if (stale === 0) {
  console.log('All cross-package version references up to date.')
} else {
  console.error(`\n${stale} stale references. Run: node scripts/sync-versions.mjs`)
  process.exit(1)
}
