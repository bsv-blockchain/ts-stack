// src/scaffold/new-project.ts
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig } from '../config/model.js'
import { layoutOf } from '../config/model.js'
import { planPlacement, writeFiles, type TargetKey } from '../engine.js'
import { resolveCapabilities } from '../registry.js'
import { renderAgentsMd } from '../agents-md.js'
import { manifestFromConfig, writeProjectManifest, MANIFEST_FILE } from '../config/project-manifest.js'
import { scaffolderFor, type RunCommand } from './base-scaffolder.js'
import { defaultRunCommand } from './run-command.js'
import { applyCapabilityDeps } from './package-json.js'
import type { CapabilityContext } from '../types.js'
import { assembleAndWrite } from './base-app.js'

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
    // Independent packages: client/ and server/ are standalone (own package.json,
    // node_modules, lockfile) — no root workspace, so neither app can resolve the
    // other's deps and each is deployable on its own.
    if (fe != null) scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, join(targetDir, 'client'), { packageManager: pm, runCommand })
    if (be != null) scaffolderFor('express').scaffold({ kind: 'backend', target: be }, join(targetDir, 'server'), { packageManager: pm, runCommand })
  } else if (fe != null) {
    scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, targetDir, { packageManager: pm, runCommand })
  } else if (be != null) {
    scaffolderFor('express').scaffold({ kind: 'backend', target: be }, targetDir, { packageManager: pm, runCommand })
  }

  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: false })
  const glue = writeFiles(placement.glueFiles, targetDir, { force: true })
  const agents = writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })
  const written: string[] = [...util.written, ...glue.written, ...agents.written]

  if (config.glue && layout !== 'none') {
    const ctx: CapabilityContext = { name: config.name, network: config.network, bsvDir: config.bsvDir, stack: config.stack, layout }
    const clientDir = layout === 'monorepo' ? join(targetDir, 'client') : (layout === 'frontend-only' ? targetDir : undefined)
    const serverDir = layout === 'monorepo' ? join(targetDir, 'server') : (layout === 'backend-only' ? targetDir : undefined)
    const r = assembleAndWrite(caps, ctx, { clientDir, serverDir })
    const cp = layout === 'monorepo' ? 'client/' : ''
    const sp = layout === 'monorepo' ? 'server/' : ''
    written.push(...r.client.map(p => cp + p), ...r.server.map(p => sp + p))
  }

  writeProjectManifest(targetDir, { ...manifestFromConfig(config), capabilities: caps.map(c => c.id) })
  written.push(MANIFEST_FILE)
  applyCapabilityDeps(targetDir, placement.deps)

  return { written, deps: placement.deps }
}
