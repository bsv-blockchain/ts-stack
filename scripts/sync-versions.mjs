#!/usr/bin/env node
/**
 * sync-versions.mjs
 *
 * Reads all workspace package.json files, builds a map of
 * { packageName → currentVersion }, then rewrites every cross-package
 * dependency reference (dependencies, devDependencies, peerDependencies)
 * so that they point at the current workspace version.
 *
 * Usage:
 *   node scripts/sync-versions.mjs [--dry-run]
 *
 * Safe to run repeatedly (idempotent). Does not touch non-workspace deps.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DRY_RUN = process.argv.includes('--dry-run')

// --- 1. Collect all workspace package.json paths ---
const output = execSync('pnpm -r ls --json --depth 0', { cwd: ROOT }).toString()
const pkgList = JSON.parse(output)

// Build name → { path, version } map
const workspaceMap = {}
for (const pkg of pkgList) {
  if (pkg.name && pkg.version && pkg.path) {
    workspaceMap[pkg.name] = { version: pkg.version, path: pkg.path }
  }
}

console.log(`Found ${Object.keys(workspaceMap).length} workspace packages`)

// --- 2. Rewrite cross-references ---
let totalChanges = 0

for (const [, { path: pkgPath }] of Object.entries(workspaceMap)) {
  const jsonPath = resolve(pkgPath, 'package.json')
  let raw
  try {
    raw = readFileSync(jsonPath, 'utf-8')
  } catch {
    continue
  }

  const pkg = JSON.parse(raw)
  let changed = false

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[field]) continue
    for (const [dep, range] of Object.entries(pkg[field])) {
      const ws = workspaceMap[dep]
      if (!ws) continue
      const target = `^${ws.version}`
      if (range !== target && range !== 'workspace:*') {
        console.log(`  ${pkg.name}: ${dep} ${range} → ${target}`)
        pkg[field][dep] = target
        changed = true
        totalChanges++
      }
    }
  }

  if (changed && !DRY_RUN) {
    writeFileSync(jsonPath, JSON.stringify(pkg, null, 2) + '\n')
  }
}

console.log(`\n${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${totalChanges} cross-package references`)
