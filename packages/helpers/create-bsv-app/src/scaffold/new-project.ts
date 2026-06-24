// src/scaffold/new-project.ts
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig } from '../config/model.js'
import { layoutOf } from '../config/model.js'
import { planPlacement, writeFiles, type TargetKey } from '../engine.js'
import { resolveCapabilities } from '../registry.js'
import { renderAgentsMd } from '../agents-md.js'
import { manifestFromConfig, writeProjectManifest } from '../config/project-manifest.js'
import { scaffolderFor, type RunCommand } from './base-scaffolder.js'
import { defaultRunCommand } from './run-command.js'
import { workspaceFiles } from './workspace.js'
import type { CapabilityContext } from '../types.js'

function ensureEmpty (dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`target directory is not empty: ${dir} — new projects scaffold into an empty directory`)
  }
}

export function scaffoldNewProject (
  config: ProjectConfig,
  targetDir: string,
  deps: { runCommand?: RunCommand } = {}
): { written: string[], deps: Record<TargetKey, Record<string, string>> } {
  const runCommand = deps.runCommand ?? defaultRunCommand
  const pm = config.packageManager
  const layout = layoutOf(config.stack)

  ensureEmpty(targetDir)
  mkdirSync(targetDir, { recursive: true })

  const fe = config.stack.frontend
  const be = config.stack.backend

  if (layout === 'monorepo') {
    if (fe != null) scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, join(targetDir, 'client'), { packageManager: pm, runCommand })
    if (be != null) scaffolderFor('express').scaffold({ kind: 'backend', target: be }, join(targetDir, 'server'), { packageManager: pm, runCommand })
    writeFiles(workspaceFiles(config.name, pm), targetDir, { force: false })
  } else if (fe != null) {
    scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, targetDir, { packageManager: pm, runCommand })
  } else if (be != null) {
    scaffolderFor('express').scaffold({ kind: 'backend', target: be }, targetDir, { packageManager: pm, runCommand })
  }

  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: false })
  writeFiles(placement.glueFiles, targetDir, { force: true })
  writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })

  if (config.glue && (layout === 'frontend-only' || layout === 'monorepo')) {
    const clientDir = layout === 'monorepo' ? join(targetDir, 'client') : targetDir
    const ctx: CapabilityContext = { name: config.name, network: config.network, bsvDir: config.bsvDir, stack: config.stack, layout }
    for (const cap of caps) {
      if (cap.clientEntry == null) continue
      writeFiles([cap.clientEntry(ctx)], clientDir, { force: true })
    }
  }

  writeProjectManifest(targetDir, { ...manifestFromConfig(config), capabilities: caps.map(c => c.id) })

  return { written: util.written, deps: placement.deps }
}
