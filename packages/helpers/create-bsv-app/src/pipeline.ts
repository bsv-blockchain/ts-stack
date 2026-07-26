import type { ProjectConfig } from './config/model.js'
import type { TargetKey, WriteResult } from './engine.js'
import { writeFiles, planPlacement } from './engine.js'
import { resolveCapabilities } from './registry.js'
import { renderAgentsMd } from './agents-md.js'
import {
  manifestFromConfig,
  writeProjectManifest,
  MANIFEST_FILE
} from './config/project-manifest.js'
import { scaffoldNewProject } from './scaffold/new-project.js'
import { applyCapabilityDeps } from './scaffold/package-json.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'
import { defaultRunCommand } from './scaffold/run-command.js'
import { installProject } from './scaffold/install.js'

export interface RunResult {
  targetDir: string
  deps: Record<TargetKey, Record<string, string>>
  written: string[]
  skipped: string[]
  installed?: boolean
  packageManager?: ProjectConfig['packageManager']
  starter?: string
}

export function addCapabilities(
  config: ProjectConfig,
  targetDir: string,
  opts: { force: boolean; runCommand?: RunCommand }
): { deps: Record<TargetKey, Record<string, string>> } & WriteResult {
  const caps = resolveCapabilities(config.capabilities, { expandRequires: false })
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: opts.force })
  const glue = writeFiles(placement.glueFiles, targetDir, { force: true })
  const agents = writeFiles(
    [{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }],
    targetDir,
    { force: true }
  )
  writeProjectManifest(targetDir, manifestFromConfig(config))
  applyCapabilityDeps(targetDir, config.targets, placement.deps)
  installProject(config, targetDir, opts.runCommand ?? defaultRunCommand)
  return {
    deps: placement.deps,
    written: [...util.written, ...glue.written, ...agents.written, MANIFEST_FILE],
    skipped: util.skipped
  }
}

export function applyConfig(
  config: ProjectConfig,
  targetDir: string,
  opts: { runCommand?: RunCommand; force?: boolean }
): RunResult {
  if (config.mode === 'new') {
    const r = scaffoldNewProject(config, targetDir, { runCommand: opts.runCommand })
    return {
      targetDir,
      deps: r.deps,
      written: r.written,
      skipped: [],
      installed: config.install,
      packageManager: config.packageManager,
      starter: config.starter
    }
  }
  const r = addCapabilities(config, targetDir, {
    force: opts.force ?? false,
    runCommand: opts.runCommand
  })
  return {
    targetDir,
    deps: r.deps,
    written: r.written,
    skipped: r.skipped,
    installed: config.install,
    packageManager: config.packageManager,
    starter: config.starter
  }
}
