#!/usr/bin/env node
/**
 * sync-versions.mjs
 *
 * Reads all workspace package.json files, builds a map of
 * { packageName → currentVersion }, then rewrites every cross-package
 * dependency reference (dependencies, devDependencies, peerDependencies)
 * so that they point at the current workspace version.
 *
 * Also walks ./infra/* package.json files (which are NOT in the pnpm
 * workspace) and rewrites their @bsv/* dependency ranges to track the
 * latest workspace versions. When an infra component's deps change, its
 * own version is patch-bumped so the infra-release workflow rebuilds
 * the image on the next `infra/v*` tag.
 *
 * Usage:
 *   node scripts/sync-versions.mjs [--dry-run]
 *
 * Safe to run repeatedly (idempotent). Does not touch non-workspace deps.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
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

// --- 3. Sync ./infra/* (not part of pnpm workspace) ---
//
// Infra components consume workspace packages from the npm registry, not via
// `workspace:*`. After a publish, their `^X.Y.Z` ranges go stale relative to
// the new workspace versions. Rewrite those ranges and patch-bump the infra
// component so the infra-release workflow picks up the new deps in its next
// Docker build.
const INFRA_DIR = resolve(ROOT, 'infra')
let infraDepChanges = 0
let infraBumps = 0

const bumpPatch = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (!m) return null
  const [, major, minor, patch, rest] = m
  return `${major}.${minor}.${Number(patch) + 1}${rest}`
}

if (existsSync(INFRA_DIR)) {
  const entries = readdirSync(INFRA_DIR)
  for (const entry of entries) {
    const componentDir = join(INFRA_DIR, entry)
    if (!statSync(componentDir).isDirectory()) continue
    const jsonPath = join(componentDir, 'package.json')
    if (!existsSync(jsonPath)) continue

    const raw = readFileSync(jsonPath, 'utf-8')
    const pkg = JSON.parse(raw)
    let changed = false

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (!pkg[field]) continue
      for (const [dep, range] of Object.entries(pkg[field])) {
        const ws = workspaceMap[dep]
        if (!ws) continue
        const target = `^${ws.version}`
        if (range !== target) {
          console.log(`  [infra] ${pkg.name}: ${dep} ${range} → ${target}`)
          pkg[field][dep] = target
          changed = true
          infraDepChanges++
        }
      }
    }

    if (changed) {
      const bumped = bumpPatch(pkg.version || '0.0.0')
      if (bumped) {
        console.log(`  [infra] ${pkg.name}: version ${pkg.version} → ${bumped}`)
        pkg.version = bumped
        infraBumps++
      }
      if (!DRY_RUN) {
        writeFileSync(jsonPath, JSON.stringify(pkg, null, 2) + '\n')
      }
    }
  }
}

console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${infraDepChanges} infra dep reference(s) across ${infraBumps} component(s)`)
