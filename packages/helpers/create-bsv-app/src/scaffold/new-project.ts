// src/scaffold/new-project.ts
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig, Layout, PackageManager, Stack } from '../config/model.js'
import { layoutOf } from '../config/model.js'
import { planPlacement, writeFiles, type TargetKey } from '../engine.js'
import { resolveCapabilities } from '../registry.js'
import { renderAgentsMd } from '../agents-md.js'
import { manifestFromConfig, writeProjectManifest, MANIFEST_FILE } from '../config/project-manifest.js'
import { scaffolderFor, type RunCommand } from './base-scaffolder.js'
import { defaultRunCommand } from './run-command.js'
import { applyCapabilityDeps } from './package-json.js'
import type { Capability, CapabilityContext } from '../types.js'
import { assembleAndWrite } from './base-app.js'

// Entries that don't count against an "empty" target dir:
// - .git: a fresh `git init` (or cloned empty repo) is a common pre-scaffold step.
// - bsv-scaffold.json: the spec a new project can be reproduced from; rewritten at the end.
const IGNORED_WHEN_EMPTY = new Set(['.git', MANIFEST_FILE])

function ensureEmpty (dir: string): void {
  if (!existsSync(dir)) return
  const blocking = readdirSync(dir).filter(e => !IGNORED_WHEN_EMPTY.has(e))
  if (blocking.length > 0) {
    throw new Error(
      `target directory is not empty: ${dir} — new projects scaffold into an empty directory ` +
      `(an existing .git or ${MANIFEST_FILE} is allowed). To extend an existing project, run in add mode ` +
      '("mode": "add" / --mode add); to scaffold fresh, clear the directory or target an empty --dir.'
    )
  }
}

// Independent packages: client/ and server/ are standalone (own package.json,
// node_modules, lockfile) — no root workspace, so neither app can resolve the
// other's deps and each is deployable on its own.
function scaffoldFrameworks (
  layout: Layout,
  stack: Stack,
  targetDir: string,
  packageManager: PackageManager,
  runCommand: RunCommand
): void {
  const opts = { packageManager, runCommand }
  const { frontend: fe, backend: be } = stack
  if (layout === 'monorepo') {
    if (fe != null) scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, join(targetDir, 'client'), opts)
    if (be != null) scaffolderFor('express').scaffold({ kind: 'backend', target: be }, join(targetDir, 'server'), opts)
    return
  }
  if (fe != null) {
    scaffolderFor('react').scaffold({ kind: 'frontend', target: fe }, targetDir, opts)
  } else if (be != null) {
    scaffolderFor('express').scaffold({ kind: 'backend', target: be }, targetDir, opts)
  }
}

function resolveClientDir (layout: Layout, targetDir: string): string | undefined {
  if (layout === 'monorepo') return join(targetDir, 'client')
  if (layout === 'frontend-only') return targetDir
  return undefined
}

function resolveServerDir (layout: Layout, targetDir: string): string | undefined {
  if (layout === 'monorepo') return join(targetDir, 'server')
  if (layout === 'backend-only') return targetDir
  return undefined
}

function writeBaseAppGlue (config: ProjectConfig, layout: Layout, caps: Capability[], targetDir: string): string[] {
  if (!config.glue || layout === 'none') return []
  const ctx: CapabilityContext = { name: config.name, network: config.network, bsvDir: config.bsvDir, stack: config.stack, layout }
  const clientDir = resolveClientDir(layout, targetDir)
  const serverDir = resolveServerDir(layout, targetDir)
  const r = assembleAndWrite(caps, ctx, { clientDir, serverDir })
  const cp = layout === 'monorepo' ? 'client/' : ''
  const sp = layout === 'monorepo' ? 'server/' : ''
  return [...r.client.map(p => cp + p), ...r.server.map(p => sp + p)]
}

export function scaffoldNewProject (
  config: ProjectConfig,
  targetDir: string,
  deps: { runCommand?: RunCommand } = {}
): { written: string[], deps: Record<TargetKey, Record<string, string>> } {
  const runCommand = deps.runCommand ?? defaultRunCommand
  const layout = layoutOf(config.stack)

  ensureEmpty(targetDir)
  mkdirSync(targetDir, { recursive: true })
  scaffoldFrameworks(layout, config.stack, targetDir, config.packageManager, runCommand)

  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: false })
  const glue = writeFiles(placement.glueFiles, targetDir, { force: true })
  const agents = writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })
  const baseAppGlue = writeBaseAppGlue(config, layout, caps, targetDir)
  const written: string[] = [...util.written, ...glue.written, ...agents.written, ...baseAppGlue]

  writeProjectManifest(targetDir, { ...manifestFromConfig(config), capabilities: caps.map(c => c.id) })
  written.push(MANIFEST_FILE)
  applyCapabilityDeps(targetDir, placement.deps)

  return { written, deps: placement.deps }
}
