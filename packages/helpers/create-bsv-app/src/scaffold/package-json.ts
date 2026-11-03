import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TargetKey } from '../engine.js'
import { targetFolder, type ProjectConfig } from '../config/model.js'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from '../file-system.js'
import { OWNED_PACKAGES } from '../capabilities/versions.js'

/** A dependency range the merge raised, or could not raise, in an existing project. */
export interface DependencyChange {
  target: TargetKey
  /** Package name. */
  name: string
  /** Range found in the project. */
  from: string
  /** Range the capability needs. */
  to: string
  action: 'raised' | 'left'
  /** Why the range was left alone; only set when `action` is `left`. */
  reason?: 'unparseable' | 'devDependency' | 'majorUpgrade'
}

const FLOOR_RE = /^(?:\^|~|>=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

/** [major, minor, patch] floor of ^x.y.z | ~x.y.z | >=x.y.z | x.y.z; undefined otherwise. */
export function rangeFloor(range: string): [number, number, number] | undefined {
  const m = FLOOR_RE.exec(range.trim())
  if (m === null) return undefined
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function compareFloors(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The caret-compatible line of a floor: its major, or for `0.x` its minor, or for `0.0.x` its patch. */
function caretLine([major, minor, patch]: [number, number, number]): string {
  if (major > 0) return `${major}`
  if (minor > 0) return `0.${minor}`
  return `0.0.${patch}`
}

/**
 * What merging `to` over an existing `from` in `dependencies` does, or undefined to keep `from`
 * silently. A raise onto another caret line is a breaking upgrade, so only packages this tool owns
 * get one; any other package is left and reported.
 */
function dependencyChange(
  name: string,
  from: string,
  to: string,
  wanted: [number, number, number]
): Omit<DependencyChange, 'target'> | undefined {
  const found = rangeFloor(from)
  if (found === undefined) return { name, from, to, action: 'left', reason: 'unparseable' }
  if (compareFloors(wanted, found) <= 0) return undefined
  if (!OWNED_PACKAGES.has(name) && caretLine(wanted) !== caretLine(found))
    return { name, from, to, action: 'left', reason: 'majorUpgrade' }
  return { name, from, to, action: 'raised' }
}

/** A `devDependencies` entry is never edited; report it when it is unparseable or below `to`. */
function devDependencyChange(
  name: string,
  from: string,
  to: string,
  wanted: [number, number, number]
): Omit<DependencyChange, 'target'> | undefined {
  const found = rangeFloor(from)
  if (found !== undefined && compareFloors(wanted, found) <= 0) return undefined
  return { name, from, to, action: 'left', reason: 'devDependency' }
}

/**
 * Adds missing names to `dependencies` and raises lower floors there, across a major only for
 * owned packages. Never edits `devDependencies`. Returns what was raised or could not be raised.
 */
export function mergePackageJsonDeps(
  dir: string,
  deps: Record<string, string>
): Omit<DependencyChange, 'target'>[] {
  const names = Object.keys(deps)
  if (names.length === 0) return []
  const file = join(dir, 'package.json')
  const current = readUtf8FileIfExists(file)
  const pkg: Record<string, unknown> = current === undefined ? {} : JSON.parse(current)
  const dependencies: Record<string, string> = (pkg.dependencies as Record<string, string>) ?? {}
  const devDependencies: Record<string, string> =
    (pkg.devDependencies as Record<string, string>) ?? {}
  const changes: Omit<DependencyChange, 'target'>[] = []
  for (const name of names) {
    const to = deps[name]
    const wanted = rangeFloor(to)
    // Capability ranges are constants in this package, so a bad one is our bug, not the project's.
    if (wanted === undefined) {
      throw new Error(`capability range for ${name} is not a plain version floor: ${to}`)
    }
    if (dependencies[name] !== undefined) {
      const change = dependencyChange(name, dependencies[name], to, wanted)
      if (change?.action === 'raised') dependencies[name] = to
      if (change !== undefined) changes.push(change)
    } else if (devDependencies[name] !== undefined) {
      const change = devDependencyChange(name, devDependencies[name], to, wanted)
      if (change !== undefined) changes.push(change)
    } else {
      dependencies[name] = to
    }
  }
  pkg.dependencies = dependencies
  mkdirSync(dirname(file), { recursive: true })
  writeUtf8FileAtomic(file, JSON.stringify(pkg, null, 2) + '\n')
  return changes
}

export function applyCapabilityDeps(
  targetDir: string,
  config: Pick<ProjectConfig, 'stack' | 'targets'>,
  deps: Record<TargetKey, Record<string, string>>
): DependencyChange[] {
  const dirForTarget = (key: TargetKey): string => {
    if (key === 'root') return targetDir
    const relative = targetFolder(config, key)
    return relative === '' ? targetDir : join(targetDir, relative)
  }
  const changes: DependencyChange[] = []
  for (const key of ['root', 'client', 'server'] as TargetKey[]) {
    for (const change of mergePackageJsonDeps(dirForTarget(key), deps[key])) {
      changes.push({ target: key, ...change })
    }
  }
  return changes
}
