#!/usr/bin/env node
/**
 * sync-versions.mjs
 *
 * Reads all workspace package.json files, builds a map of
 * { packageName → currentVersion }, then rewrites every cross-package
 * dependency reference (dependencies, devDependencies, peerDependencies)
 * so that they point at the current workspace version.
 *
 * Also walks ./infra/* and the nested UHRP notifier package.json files (NOT in the pnpm
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

import {
  readFileSync,
  readdirSync,
  realpathSync,
  existsSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { resolve, dirname, join, delimiter, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { acceptsPeerVersion } from './peer-version-range.mjs'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]
const PNPM_NAMES = new Set(['pnpm', 'pnpm.cjs', 'pnpm.js'])

function nodePnpmLauncher(executable) {
  const prefix = readFileSync(executable).subarray(0, 128).toString('utf8')
  return prefix.startsWith('#!') && prefix.split('\n', 1)[0].includes('node')
}

function packagePnpmLauncher(directory, packageName, relativeLauncher) {
  const packageDirectory = resolve(directory, 'node_modules', packageName)
  const executable = resolve(packageDirectory, relativeLauncher)
  const metadata = readUtf8FileIfExists(resolve(packageDirectory, 'package.json'))
  if (metadata === undefined || !existsSync(executable)) return undefined
  if (JSON.parse(metadata)?.name !== packageName) return undefined
  const qualified = realpathSync(executable)
  if (!qualified.startsWith(realpathSync(packageDirectory) + sep)) return undefined
  return { executable: qualified, nodeLauncher: true }
}

function readBoundedShim(executable) {
  const descriptor = openSync(executable, 'r')
  try {
    const bytes = Buffer.alloc(8_193)
    const count = readSync(descriptor, bytes, 0, bytes.length, 0)
    return count > 8_192 ? undefined : bytes.subarray(0, count).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

const SHIM_TARGET =
  /"(?:%~dp0|%dp0%|\$basedir|\$\{basedir\})\/node_modules\/(pnpm\/bin\/pnpm\.cjs|corepack\/dist\/pnpm\.js)"/gi
const SHIM_NODE_COMMANDS = [
  '"%_prog%" ',
  '"%~dp0/node.exe" ',
  '"%dp0%/node.exe" ',
  '& "$basedir/node$exe" ',
  '& "node$exe" ',
  'exec "$basedir/node" ',
  'exec node '
]

function shimInvokesNode(line) {
  const lower = line.trimStart().toLowerCase()
  if (['rem ', '::', '#', 'echo ', '@echo '].some(prefix => lower.startsWith(prefix))) return false
  return SHIM_NODE_COMMANDS.some(command => lower.includes(command))
}

function selectedShimRoute(source) {
  if (source === undefined) return undefined
  const targets = new Set()
  for (const line of source.replaceAll('\\', '/').split('\n')) {
    if (!shimInvokesNode(line)) continue
    for (const match of line.matchAll(SHIM_TARGET)) targets.add(match[1].toLowerCase())
  }
  if (targets.size !== 1) return undefined
  return [...targets][0]
}

function windowsShimLauncher(directory, shim) {
  const route = selectedShimRoute(readBoundedShim(resolve(directory, shim)))
  if (route === undefined)
    throw new Error('Cannot locate pnpm: unknown or incoherent Windows shim route')
  const separator = route.indexOf('/')
  const launcher = packagePnpmLauncher(
    directory,
    route.slice(0, separator),
    route.slice(separator + 1)
  )
  if (launcher === undefined)
    throw new Error('Cannot locate pnpm: Windows shim target package is missing or invalid')
  return launcher
}

function windowsPnpmLauncher(directory) {
  const native = resolve(directory, 'pnpm.exe')
  if (existsSync(native)) return { executable: realpathSync(native), nodeLauncher: false }
  const shim = ['pnpm.cmd', 'pnpm.ps1', 'pnpm'].find(name => existsSync(resolve(directory, name)))
  return shim === undefined ? undefined : windowsShimLauncher(directory, shim)
}

function pathPnpmLauncher(directory, platform) {
  if (platform === 'win32') return windowsPnpmLauncher(directory)
  const candidate = resolve(directory, 'pnpm')
  if (!existsSync(candidate)) return undefined
  const executable = realpathSync(candidate)
  return { executable, nodeLauncher: nodePnpmLauncher(executable) }
}

function configuredPnpmLauncher(root, configured, platform) {
  if (!configured) return undefined
  const executable = resolve(root, configured)
  const name = basename(executable)
  if (platform === 'win32' && ['pnpm.cmd', 'pnpm.ps1'].includes(name))
    return existsSync(executable) ? windowsShimLauncher(dirname(executable), name) : undefined
  if (!PNPM_NAMES.has(name) || !existsSync(executable)) return undefined
  const qualified = realpathSync(executable)
  return { executable: qualified, nodeLauncher: nodePnpmLauncher(qualified) }
}

/** Resolve the launcher without relying on shell/PATHEXT command execution. */
export function resolvePnpmLauncher(root, environment = process.env, platform = process.platform) {
  const pathValue = environment.PATH ?? environment.Path ?? ''
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  for (const directory of pathValue.split(pathDelimiter)) {
    const launcher = pathPnpmLauncher(resolve(root, directory), platform)
    if (launcher !== undefined) return launcher
  }
  const configured = configuredPnpmLauncher(root, environment.npm_execpath, platform)
  if (configured !== undefined) return configured
  throw new Error('Cannot locate pnpm for workspace package discovery')
}

/** Resolve pnpm once, then pass the fixed listing arguments without a shell. */
export function listWorkspacePackages(
  root,
  environment = process.env,
  platform = process.platform
) {
  const { executable, nodeLauncher } = resolvePnpmLauncher(root, environment, platform)
  const command = nodeLauncher ? process.execPath : executable
  const arguments_ = ['-r', 'ls', '--json', '--depth', '0']
  if (nodeLauncher) arguments_.unshift(executable)
  return JSON.parse(
    execFileSync(command, arguments_, { cwd: root, env: environment, encoding: 'utf8' })
  )
}

function workspacePackages(pkgList) {
  const result = {}
  for (const pkg of pkgList) {
    if (pkg.name && pkg.version && pkg.path)
      result[pkg.name] = { version: pkg.version, path: pkg.path }
  }
  return result
}

function readWorkspacePackage(jsonPath) {
  let raw
  try {
    raw = readFileSync(jsonPath, 'utf-8')
  } catch {
    return undefined
  }
  return JSON.parse(raw)
}

function writePackageIfChanged(jsonPath, pkg, changes, dryRun) {
  if (changes > 0 && !dryRun) writeUtf8FileAtomic(jsonPath, JSON.stringify(pkg, null, 2) + '\n')
}

function workspaceReference(field, range, version) {
  if (field === 'peerDependencies')
    return { target: `^${version}`, valid: acceptsPeerVersion(range, version) }
  return { target: 'workspace:^', valid: range === 'workspace:^' }
}

function rewriteWorkspaceReferences(pkg, workspaceMap) {
  let changes = 0
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      const ws = workspaceMap[dep]
      if (!ws) continue
      // Installation edges use workspace links; peers retain their compatibility contract.
      const { target, valid } = workspaceReference(field, range, ws.version)
      if (valid) continue
      console.log(`  ${pkg.name}: ${dep} ${range} → ${target}`)
      pkg[field][dep] = target
      changes++
    }
  }
  return changes
}

function syncWorkspaceReferences(workspaceMap, dryRun) {
  let totalChanges = 0
  for (const { path: pkgPath } of Object.values(workspaceMap)) {
    const jsonPath = resolve(pkgPath, 'package.json')
    const pkg = readWorkspacePackage(jsonPath)
    if (pkg === undefined) continue
    const changes = rewriteWorkspaceReferences(pkg, workspaceMap)
    totalChanges += changes
    writePackageIfChanged(jsonPath, pkg, changes, dryRun)
  }
  return totalChanges
}

const isAsciiDigit = code => code >= 48 && code <= 57
function allDigits(value) {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i++) {
    if (!isAsciiDigit(value.codePointAt(i))) return false
  }
  return true
}

// Preserve the existing bounded scanner, including its suffix and leading-zero behavior.
function bumpPatch(version) {
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
  while (patchEnd < tail.length && isAsciiDigit(tail.codePointAt(patchEnd))) patchEnd++
  if (patchEnd === 0) return null
  const patch = Number(tail.slice(0, patchEnd))
  return `${major}.${minor}.${patch + 1}${tail.slice(patchEnd)}`
}

function infraComponentDirectories(root) {
  const infraDirectory = resolve(root, 'infra')
  let entries = []
  try {
    entries = readdirSync(infraDirectory, { withFileTypes: true })
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(infraDirectory, entry.name))
  directories.push(join(infraDirectory, 'uhrp-server-cloud-bucket', 'notifier'))
  return directories
}

function rewriteInfraReferences(pkg, workspaceMap) {
  let changes = 0
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      const ws = workspaceMap[dep]
      if (!ws) continue
      const target = `^${ws.version}`
      if (range === target) continue
      console.log(`  [infra] ${pkg.name}: ${dep} ${range} → ${target}`)
      pkg[field][dep] = target
      changes++
    }
  }
  return changes
}

function bumpInfraPackage(pkg) {
  const bumped = bumpPatch(pkg.version || '0.0.0')
  if (!bumped) return 0
  console.log(`  [infra] ${pkg.name}: version ${pkg.version} → ${bumped}`)
  pkg.version = bumped
  return 1
}

function syncInfraReferences(root, workspaceMap, dryRun) {
  let changes = 0
  let bumps = 0
  for (const directory of infraComponentDirectories(root)) {
    const jsonPath = join(directory, 'package.json')
    const raw = readUtf8FileIfExists(jsonPath)
    if (raw === undefined) continue
    const pkg = JSON.parse(raw)
    const componentChanges = rewriteInfraReferences(pkg, workspaceMap)
    if (componentChanges === 0) continue
    changes += componentChanges
    bumps += bumpInfraPackage(pkg)
    writePackageIfChanged(jsonPath, pkg, componentChanges, dryRun)
  }
  return { changes, bumps }
}

export function syncVersions({
  root = ROOT,
  dryRun = false,
  workspaceOnly = false,
  packageList
} = {}) {
  const workspaceMap = workspacePackages(packageList ?? listWorkspacePackages(root))
  console.log(`Found ${Object.keys(workspaceMap).length} workspace packages`)
  const changes = syncWorkspaceReferences(workspaceMap, dryRun)
  console.log(
    `\n${dryRun ? '[DRY RUN] Would update' : 'Updated'} ${changes} cross-package references`
  )
  const infra = workspaceOnly
    ? { changes: 0, bumps: 0 }
    : syncInfraReferences(root, workspaceMap, dryRun)
  console.log(
    `${dryRun ? '[DRY RUN] Would update' : 'Updated'} ${infra.changes} infra dep reference(s) across ${infra.bumps} component(s)`
  )
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  syncVersions({
    dryRun: process.argv.includes('--dry-run'),
    workspaceOnly: process.argv.includes('--workspace-only')
  })
}
