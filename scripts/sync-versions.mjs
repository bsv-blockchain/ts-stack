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
      // `workspace:^` is the canonical form for cross-workspace deps in this repo —
      // publishes as `^X.Y.Z` so downstream installs dedupe. `workspace:*` publishes
      // as an exact pin and causes duplicate-install bugs; rewrite it to `workspace:^`.
      if (range === 'workspace:*') {
        console.log(`  ${pkg.name}: ${dep} workspace:* → workspace:^`)
        pkg[field][dep] = 'workspace:^'
        changed = true
        totalChanges++
        continue
      }
      if (range !== target && range !== 'workspace:^') {
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

// Plain-string parse of a semver-shaped `MAJOR.MINOR.PATCH[suffix]`. Avoids a
// regex so we can't accidentally hit catastrophic backtracking (and don't trip
// SonarCloud's typescript:S5852 "super-linear regex" rule) on a degenerate
// version string. Linear scan, capped length.
const isAsciiDigit = (code) => code >= 48 && code <= 57
const allDigits = (s) => {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    if (!isAsciiDigit(s.charCodeAt(i))) return false
  }
  return true
}
const bumpPatch = (version) => {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null

  const dot1 = version.indexOf('.')
  if (dot1 < 1) return null
  const dot2 = version.indexOf('.', dot1 + 1)
  if (dot2 < dot1 + 2) return null

  const major = version.slice(0, dot1)
  const minor = version.slice(dot1 + 1, dot2)
  if (!allDigits(major) || !allDigits(minor)) return null

  const tail = version.slice(dot2 + 1)
  let patchEnd = 0
  while (patchEnd < tail.length && isAsciiDigit(tail.charCodeAt(patchEnd))) {
    patchEnd++
  }
  if (patchEnd === 0) return null

  const patch = Number(tail.slice(0, patchEnd))
  const suffix = tail.slice(patchEnd)
  return `${major}.${minor}.${patch + 1}${suffix}`
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
