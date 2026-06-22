import { basename } from 'node:path'
import type { Framework, Selection } from './types.js'
import { writeFiles, planPlacement, type WriteResult, type TargetKey } from './engine.js'
import { manifestFromConfig, writeProjectManifest, readValidManifest, mergeCapabilityIds } from './config/project-manifest.js'
import type { ProjectManifest } from './config/project-manifest.js'
import { renderAgentsMd } from './agents-md.js'
import { selectionToConfig } from './config/bridge.js'
import type { ProjectConfig } from './config/model.js'
import { resolveCapabilities } from './registry.js'

export interface CliArgs {
  dir?: string
  name?: string
  network: 'main' | 'test'
  framework?: Framework
  capabilities: string[]
  yes: boolean
  force: boolean
  ui: boolean
}

export type PromptProvider = (opts: { existing: ProjectManifest | null }) => Promise<Selection>

export function parseArgs (argv: string[]): CliArgs {
  const args: CliArgs = { network: 'test', capabilities: [], yes: false, force: false, ui: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') {
      i += 1
      args.dir = argv[i]
    } else if (a === '--name') {
      i += 1
      args.name = argv[i]
    } else if (a === '--network') {
      i += 1
      args.network = argv[i] === 'main' ? 'main' : 'test'
    } else if (a === '--framework') {
      i += 1
      args.framework = argv[i] === 'react' ? 'react' : 'express'
    } else if (a === '--capabilities') {
      i += 1
      args.capabilities = (argv[i] ?? '').split(',').filter(Boolean)
    } else if (a === '--yes') {
      args.yes = true
    } else if (a === '--force') {
      args.force = true
    } else if (a === '--ui') {
      args.ui = true
    } else if (args.dir === undefined && !a.startsWith('--')) {
      args.dir = a
    }
  }
  return args
}

export async function run (
  argv: string[],
  prompt?: PromptProvider
): Promise<{ targetDir: string, deps: Record<TargetKey, Record<string, string>> } & WriteResult> {
  const args = parseArgs(argv)
  const targetDir = args.dir ?? '.'
  const existing = readValidManifest(targetDir)

  let lockedFramework: Framework | undefined
  if (existing !== null) {
    if (existing.stack.frontend != null) {
      lockedFramework = 'react'
    } else if (existing.stack.backend != null) {
      lockedFramework = 'express'
    }
  }
  const framework: Framework | undefined = lockedFramework ?? args.framework

  let selection: Selection
  const isNonInteractive = args.yes && args.capabilities.length > 0 && framework !== undefined
  if (isNonInteractive) {
    selection = {
      appName: args.name ?? existing?.name ?? basename(targetDir),
      network: existing?.network ?? args.network,
      framework,
      capabilityIds: mergeCapabilityIds(existing?.capabilities ?? [], args.capabilities)
    }
  } else {
    if (prompt === undefined) throw new Error('interactive run requires a prompt provider')
    const raw = await prompt({ existing })
    selection = { ...raw, capabilityIds: mergeCapabilityIds(existing?.capabilities ?? [], raw.capabilityIds) }
  }

  let config: ProjectConfig = selectionToConfig(selection)
  if (existing !== null) {
    config = { ...config, name: existing.name, network: existing.network, stack: existing.stack, bsvDir: existing.bsvDir }
  }

  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: args.force })
  writeFiles(placement.glueFiles, targetDir, { force: true })
  writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })
  writeProjectManifest(targetDir, manifestFromConfig(config))

  return { targetDir, deps: placement.deps, written: util.written, skipped: util.skipped }
}
