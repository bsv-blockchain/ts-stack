import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TargetKey } from '../engine.js'
import type { TargetPaths } from '../config/model.js'

export function mergePackageJsonDeps (dir: string, deps: Record<string, string>): void {
  const names = Object.keys(deps)
  if (names.length === 0) return
  const file = join(dir, 'package.json')
  const pkg: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const dependencies: Record<string, string> = (pkg.dependencies as Record<string, string>) ?? {}
  const devDependencies: Record<string, string> = (pkg.devDependencies as Record<string, string>) ?? {}
  for (const name of names) {
    if (dependencies[name] === undefined && devDependencies[name] === undefined) dependencies[name] = deps[name]
  }
  pkg.dependencies = dependencies
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}

export function applyCapabilityDeps (targetDir: string, targets: TargetPaths, deps: Record<TargetKey, Record<string, string>>): void {
  const dirForTarget = (key: TargetKey): string => {
    if (key === 'root') return targetDir
    const relative = targets[key] ?? key
    return relative === '' ? targetDir : join(targetDir, relative)
  }
  for (const key of ['root', 'client', 'server'] as TargetKey[]) {
    mergePackageJsonDeps(dirForTarget(key), deps[key])
  }
}
