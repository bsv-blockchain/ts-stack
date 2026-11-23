import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PackageManager, ProjectConfig } from '../config/model.js'
import { layoutOf, targetFolder } from '../config/model.js'
import { layoutHasRole } from '../engine.js'
import type { RunCommand } from './base-scaffolder.js'
import { getStarter } from '../starters.js'

function packageManagerFor(dir: string, fallback: PackageManager): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm'
  return fallback
}

export function installProject(
  config: ProjectConfig,
  targetDir: string,
  runCommand: RunCommand
): string[] {
  if (!config.install) return []
  // recorded targets, plus the layout's own ones at their default folders when none are recorded
  const layout = layoutOf(config.stack)
  const candidates = (['client', 'server'] as const)
    .filter(t => config.targets[t] !== undefined || layoutHasRole(layout, t))
    .map(t => targetFolder(config, t))
    .map(path => (path === '' ? targetDir : join(targetDir, path)))
  if (
    getStarter(config.starter)?.kind === 'repository' &&
    existsSync(join(targetDir, 'package.json'))
  )
    candidates.unshift(targetDir)
  if (candidates.length === 0 && existsSync(join(targetDir, 'package.json')))
    candidates.push(targetDir)

  const dirs = [...new Set(candidates)].filter(dir => existsSync(join(dir, 'package.json')))
  for (const dir of dirs) {
    const packageManager = packageManagerFor(dir, config.packageManager)
    runCommand(packageManager, ['install'], { cwd: dir })
  }
  return dirs
}
