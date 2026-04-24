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
      const expected = `^${wsVersion}`
      if (range !== expected && range !== 'workspace:*') {
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
