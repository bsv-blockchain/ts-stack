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
import { resolve, dirname, sep } from 'node:path'
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

function acceptsPeerVersion (range, wsVersion) {
  if (range === `^${wsVersion}`) return true
  if (!range.startsWith('^')) return false

  const min = parseVersion(range.slice(1))
  const current = parseVersion(wsVersion)
  if (!min || !current) return false

  return compareVersion(current, min) >= 0 && compareVersion(current, caretUpperBound(min)) < 0
}

let stale = 0
let coverageMismatches = 0
let runtimeToolLeaks = 0

const developmentOnlyPackages = new Set([
  '@jest/globals',
  'jest',
  'oxlint',
  'supertest',
  'ts-jest',
  'ts2md',
  'tsconfig-to-dual-package',
  'typescript'
])

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
  if (d.private !== true) {
    for (const dependency of Object.keys(d.dependencies ?? {})) {
      if (dependency.startsWith('@types/') || developmentOnlyPackages.has(dependency)) {
        console.log(`PUBLISH SURFACE  ${d.name} exposes development-only dependency ${dependency}`)
        runtimeToolLeaks++
      }
    }
  }

  const testCommand = d.scripts?.test
  const coverageCommand = d.scripts?.['test:coverage']
  if (typeof testCommand === 'string' && typeof coverageCommand === 'string') {
    const missingCoverageBehaviors = [
      '--passWithNoTests',
      '--experimental-vm-modules'
    ].filter(option => testCommand.includes(option) && !coverageCommand.includes(option))

    if (
      coverageCommand.includes('--coverageReporters') &&
      !coverageCommand.includes('--coverageReporters=lcov')
    ) {
      missingCoverageBehaviors.push('--coverageReporters=lcov')
    }

    if (missingCoverageBehaviors.length > 0) {
      console.log(`COVERAGE MISMATCH  ${d.name} test:coverage is missing ${missingCoverageBehaviors.join(', ')}`)
      coverageMismatches++
    }
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!d[field]) continue
    for (const [dep, range] of Object.entries(d[field])) {
      const wsVersion = workspaceMap[dep]
      if (!wsVersion) continue
      const valid = field === 'peerDependencies'
        ? acceptsPeerVersion(range, wsVersion)
        : range === 'workspace:^'
      if (!valid) {
        console.log(`STALE  ${d.name}  ${dep}  ${range}  (current: ${wsVersion})`)
        stale++
      }
    }
  }
}

// Nested-package version lockstep.
//
// Some workspace packages are alternate entrypoints that live INSIDE another
// package's directory (e.g. wallet-toolbox/client and wallet-toolbox/mobile
// share the wallet-toolbox build and are published as @bsv/wallet-toolbox-client
// / -mobile). They must carry the SAME version as their enclosing package: the
// release publishes by committed version, so if a subpackage lags its parent it
// silently fails to publish, and `sync-versions` then rewrites consumers to a
// range that was never published (ERR_PNPM_NO_MATCHING_VERSION). Enforce here so
// a version bump that forgets the subpackages fails in CI, not at release time.
const located = pkgList.filter(p => p.name && p.version && p.path)
let mismatched = 0

const isPrivate = (pkgPath) => {
  try {
    return JSON.parse(readFileSync(resolve(pkgPath, 'package.json'), 'utf-8')).private === true
  } catch {
    return false
  }
}

for (const child of located) {
  // Only publishable subpackages need lockstep — private nested packages
  // (e.g. example apps under a library's docs/) are never published.
  if (isPrivate(child.path)) continue
  // Closest enclosing workspace package (longest matching ancestor path).
  let parent = null
  for (const cand of located) {
    if (cand === child) continue
    if (!child.path.startsWith(cand.path + sep)) continue
    if (!parent || cand.path.length > parent.path.length) parent = cand
  }
  if (!parent) continue
  if (child.version !== parent.version) {
    console.log(`VERSION MISMATCH  ${child.name}@${child.version}  must match enclosing  ${parent.name}@${parent.version}`)
    mismatched++
  }
}

if (stale === 0 && mismatched === 0 && coverageMismatches === 0 && runtimeToolLeaks === 0) {
  console.log('All cross-package version references up to date.')
} else {
  if (stale > 0) console.error(`\n${stale} stale references. Run: node scripts/sync-versions.mjs --workspace-only`)
  if (mismatched > 0) console.error(`\n${mismatched} nested package(s) out of lockstep with their enclosing package. Bump them to match.`)
  if (coverageMismatches > 0) console.error(`\n${coverageMismatches} coverage script(s) disagree with their package test semantics.`)
  if (runtimeToolLeaks > 0) console.error(`\n${runtimeToolLeaks} development-only dependency entries would leak into published runtime installs.`)
  process.exit(1)
}
