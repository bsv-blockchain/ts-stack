#!/usr/bin/env node
/** Reports stale workspace references and inconsistent publication/test policies. */
import { readFileSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptsPeerVersion } from './peer-version-range.mjs'
import { listWorkspacePackages } from './sync-versions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]
const DEVELOPMENT_ONLY_PACKAGES = new Set([
  '@jest/globals',
  '@typescript/native',
  'jest',
  'oxlint',
  'supertest',
  'ts-jest',
  'ts2md',
  'tsconfig-to-dual-package',
  'typescript'
])
export { acceptsPeerVersion } from './peer-version-range.mjs'

function runtimePackageForTypes(dependency) {
  const name = dependency.slice('@types/'.length)
  const scopedSeparator = name.indexOf('__')
  return scopedSeparator === -1
    ? name
    : `@${name.slice(0, scopedSeparator)}/${name.slice(scopedSeparator + 2)}`
}

function readPackageIfPresent(pkgPath) {
  let raw
  try {
    raw = readFileSync(resolve(pkgPath, 'package.json'), 'utf-8')
  } catch {
    return undefined
  }
  return JSON.parse(raw)
}

function workspaceVersions(pkgList) {
  const result = {}
  for (const pkg of pkgList) {
    if (pkg.name && pkg.version) result[pkg.name] = pkg.version
  }
  return result
}

function checkRuntimeTools(pkg, declarationDependencies) {
  let leaks = 0
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    if (
      DEVELOPMENT_ONLY_PACKAGES.has(dependency) ||
      (dependency.startsWith('@types/') && !declarationDependencies.has(dependency))
    ) {
      console.log(`PUBLISH SURFACE  ${pkg.name} exposes development-only dependency ${dependency}`)
      leaks++
    }
  }
  return leaks
}

function checkDeclarationDependencies(pkg, declarationDependencies) {
  let leaks = 0
  const publishedDependencies = { ...pkg.dependencies, ...pkg.peerDependencies }
  const runtimeSurface = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies
  }
  for (const dependency of declarationDependencies) {
    if (!Object.hasOwn(publishedDependencies, dependency)) {
      console.log(
        `DECLARATION DEPENDENCY  ${pkg.name} must publish governed dependency ${dependency}`
      )
      leaks++
    }
    const runtimePackage = runtimePackageForTypes(dependency)
    if (!Object.hasOwn(runtimeSurface, runtimePackage)) {
      console.log(
        `DECLARATION DEPENDENCY  ${pkg.name} publishes ${dependency} without ${runtimePackage}`
      )
      leaks++
    }
  }
  return leaks
}

function checkPublishSurface(pkg, projectPolicies) {
  if (pkg.private === true) return 0
  const dependencies = new Set(projectPolicies.get(pkg.name)?.declarationDependencies ?? [])
  return checkRuntimeTools(pkg, dependencies) + checkDeclarationDependencies(pkg, dependencies)
}

function checkCoverageSemantics(pkg) {
  const testCommand = pkg.scripts?.test
  const coverageCommand = pkg.scripts?.['test:coverage']
  if (typeof testCommand !== 'string' || typeof coverageCommand !== 'string') return 0
  const missing = ['--passWithNoTests', '--experimental-vm-modules'].filter(
    option => testCommand.includes(option) && !coverageCommand.includes(option)
  )
  if (
    coverageCommand.includes('--coverageReporters') &&
    !coverageCommand.includes('--coverageReporters=lcov')
  )
    missing.push('--coverageReporters=lcov')
  if (missing.length === 0) return 0
  console.log(`COVERAGE MISMATCH  ${pkg.name} test:coverage is missing ${missing.join(', ')}`)
  return 1
}

function checkWorkspaceReferences(pkg, workspaceMap) {
  let stale = 0
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      const wsVersion = workspaceMap[dep]
      if (!wsVersion) continue
      const valid =
        field === 'peerDependencies'
          ? acceptsPeerVersion(range, wsVersion)
          : range === 'workspace:^'
      if (!valid) {
        console.log(`STALE  ${pkg.name}  ${dep}  ${range}  (current: ${wsVersion})`)
        stale++
      }
    }
  }
  return stale
}

function isPrivate(pkgPath) {
  try {
    return JSON.parse(readFileSync(resolve(pkgPath, 'package.json'), 'utf-8')).private === true
  } catch {
    return false
  }
}

function closestEnclosingPackage(child, located) {
  let parent = null
  for (const candidate of located) {
    if (candidate === child || !child.path.startsWith(candidate.path + sep)) continue
    if (!parent || candidate.path.length > parent.path.length) parent = candidate
  }
  return parent
}

// Publishable alternate entrypoints must match their closest enclosing package.
function checkNestedLockstep(pkgList) {
  const located = pkgList.filter(pkg => pkg.name && pkg.version && pkg.path)
  let mismatched = 0
  for (const child of located) {
    if (isPrivate(child.path)) continue
    const parent = closestEnclosingPackage(child, located)
    if (parent && child.version !== parent.version) {
      console.log(
        `VERSION MISMATCH  ${child.name}@${child.version}  must match enclosing  ${parent.name}@${parent.version}`
      )
      mismatched++
    }
  }
  return mismatched
}

function reportProblems({ stale, mismatched, coverageMismatches, runtimeToolLeaks }) {
  if (stale === 0 && mismatched === 0 && coverageMismatches === 0 && runtimeToolLeaks === 0) {
    console.log('All cross-package version references up to date.')
    return
  }
  if (stale > 0)
    console.error(
      `\n${stale} stale references. Run: node scripts/sync-versions.mjs --workspace-only`
    )
  if (mismatched > 0)
    console.error(
      `\n${mismatched} nested package(s) out of lockstep with their enclosing package. Bump them to match.`
    )
  if (coverageMismatches > 0)
    console.error(
      `\n${coverageMismatches} coverage script(s) disagree with their package test semantics.`
    )
  if (runtimeToolLeaks > 0)
    console.error(
      `\n${runtimeToolLeaks} development-only dependency entries would leak into published runtime installs.`
    )
  process.exit(1)
}

export function checkVersions({ root = ROOT, packageList } = {}) {
  const registry = JSON.parse(
    readFileSync(resolve(root, 'governance/repository-health/projects.json'), 'utf8')
  )
  const policies = new Map(registry.projects.map(project => [project.name, project]))
  const packages = packageList ?? listWorkspacePackages(root)
  const versions = workspaceVersions(packages)
  const problems = { stale: 0, coverageMismatches: 0, runtimeToolLeaks: 0 }
  for (const pkg of packages) {
    if (!pkg.path) continue
    const manifest = readPackageIfPresent(pkg.path)
    if (manifest === undefined) continue
    problems.runtimeToolLeaks += checkPublishSurface(manifest, policies)
    problems.coverageMismatches += checkCoverageSemantics(manifest)
    problems.stale += checkWorkspaceReferences(manifest, versions)
  }
  reportProblems({ ...problems, mismatched: checkNestedLockstep(packages) })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkVersions()
