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

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DRY_RUN = process.argv.includes('--dry-run')
const WORKSPACE_ONLY = process.argv.includes('--workspace-only')

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

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

function compareVersion(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function caretUpperBound(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: version.patch + 1 }
}

function acceptsPeerVersion(range, wsVersion) {
  if (!range.startsWith('^')) return false
  const minimum = parseVersion(range.slice(1))
  const current = parseVersion(wsVersion)
  if (!minimum || !current) return false
  return (
    compareVersion(current, minimum) >= 0 && compareVersion(current, caretUpperBound(minimum)) < 0
  )
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

  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    if (!pkg[field]) continue
    for (const [dep, range] of Object.entries(pkg[field])) {
      const ws = workspaceMap[dep]
      if (!ws) continue
      // Runtime, development, and optional workspace edges must link to the
      // local package. pnpm rewrites workspace:^ to ^X.Y.Z during publish.
      // Peer ranges remain ordinary semver because they express the public
      // compatibility contract rather than an installation edge.
      const target = field === 'peerDependencies' ? `^${ws.version}` : 'workspace:^'
      const valid =
        field === 'peerDependencies' ? acceptsPeerVersion(range, ws.version) : range === target
      if (!valid) {
        console.log(`  ${pkg.name}: ${dep} ${range} → ${target}`)
        pkg[field][dep] = target
        changed = true
        totalChanges++
      }
    }
  }

  if (changed && !DRY_RUN) {
    writeUtf8FileAtomic(jsonPath, JSON.stringify(pkg, null, 2) + '\n')
  }
}

console.log(
  `\n${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${totalChanges} cross-package references`
)

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
const isAsciiDigit = code => code >= 48 && code <= 57
const allDigits = s => {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    if (!isAsciiDigit(s.codePointAt(i))) return false
  }
  return true
}
const bumpPatch = version => {
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
  while (patchEnd < tail.length && isAsciiDigit(tail.codePointAt(patchEnd))) {
    patchEnd++
  }
  if (patchEnd === 0) return null

  const patch = Number(tail.slice(0, patchEnd))
  const suffix = tail.slice(patchEnd)
  return `${major}.${minor}.${patch + 1}${suffix}`
}

if (!WORKSPACE_ONLY) {
  let entries = []
  try {
    entries = readdirSync(INFRA_DIR, { withFileTypes: true })
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const componentDir = join(INFRA_DIR, entry.name)
    const jsonPath = join(componentDir, 'package.json')
    const raw = readUtf8FileIfExists(jsonPath)
    if (raw === undefined) continue
    const pkg = JSON.parse(raw)
    let changed = false

    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
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
        writeUtf8FileAtomic(jsonPath, JSON.stringify(pkg, null, 2) + '\n')
      }
    }
  }
}

console.log(
  `${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${infraDepChanges} infra dep reference(s) across ${infraBumps} component(s)`
)
