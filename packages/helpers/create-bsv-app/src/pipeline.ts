import type { ProjectConfig } from './config/model.js'
import type { TargetKey, WriteResult } from './engine.js'
import { writeFiles, planPlacement } from './engine.js'
import { resolveCapabilities } from './registry.js'
import { renderAgentsMd } from './agents-md.js'
import { manifestFromConfig, writeProjectManifest } from './config/project-manifest.js'
import { scaffoldNewProject } from './scaffold/new-project.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'

export interface RunResult {
  targetDir: string
  deps: Record<TargetKey, Record<string, string>>
  written: string[]
  skipped: string[]
}

export function addCapabilities (
  config: ProjectConfig,
  targetDir: string,
  opts: { force: boolean }
): { deps: Record<TargetKey, Record<string, string>> } & WriteResult {
  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: opts.force })
  writeFiles(placement.glueFiles, targetDir, { force: true })
  writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })
  writeProjectManifest(targetDir, manifestFromConfig(config))
  return { deps: placement.deps, written: util.written, skipped: util.skipped }
}

export function applyConfig (
  config: ProjectConfig,
  targetDir: string,
  opts: { runCommand?: RunCommand, force?: boolean }
): RunResult {
  if (config.mode === 'new') {
    const r = scaffoldNewProject(config, targetDir, { runCommand: opts.runCommand })
    return { targetDir, deps: r.deps, written: r.written, skipped: [] }
  }
  const r = addCapabilities(config, targetDir, { force: opts.force ?? false })
  return { targetDir, deps: r.deps, written: r.written, skipped: r.skipped }
}
