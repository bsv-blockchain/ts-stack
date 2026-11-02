import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TargetKey } from '../engine.js'
import type { TargetPaths } from '../config/model.js'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from '../file-system.js'

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
  reason?: 'unparseable' | 'devDependency'
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

/**
 * Adds missing names to `dependencies` and raises lower floors there. Never edits
 * `devDependencies`. Returns what was raised or could not be raised.
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
      const from = dependencies[name]
      const found = rangeFloor(from)
      if (found === undefined) {
        changes.push({ name, from, to, action: 'left', reason: 'unparseable' })
      } else if (compareFloors(wanted, found) > 0) {
        dependencies[name] = to
        changes.push({ name, from, to, action: 'raised' })
      }
    } else if (devDependencies[name] !== undefined) {
      const from = devDependencies[name]
      const found = rangeFloor(from)
      if (found === undefined || compareFloors(wanted, found) > 0) {
        changes.push({ name, from, to, action: 'left', reason: 'devDependency' })
      }
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
  targets: TargetPaths,
  deps: Record<TargetKey, Record<string, string>>
): DependencyChange[] {
  const dirForTarget = (key: TargetKey): string => {
    if (key === 'root') return targetDir
    const relative = targets[key] ?? key
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
