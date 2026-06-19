import { basename } from 'node:path'
import type { Framework, Manifest, Selection } from './types.js'
import { planFiles, writeFiles, aggregateDependencies, type WriteResult } from './engine.js'
import { manifestFromSelection, writeManifest, readManifest, mergeCapabilityIds } from './manifest.js'
import { renderAgentsMd } from './agents-md.js'

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

export type PromptProvider = (opts: { existing: Manifest | null }) => Promise<Selection>

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
): Promise<{ targetDir: string, dependencies: Record<string, string> } & WriteResult> {
  const args = parseArgs(argv)
  const targetDir = args.dir ?? '.'
  const existing = readManifest(targetDir)

  const framework: Framework | undefined = existing?.framework ?? args.framework

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
    selection = { ...raw, capabilityIds: mergeCapabilityIds([], raw.capabilityIds) }
  }

  const specs = planFiles(selection)
  const fileResult = writeFiles(specs, targetDir, { force: args.force })
  writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(selection) }], targetDir, { force: true })
  writeManifest(targetDir, manifestFromSelection(selection))

  return { targetDir, dependencies: aggregateDependencies(selection), ...fileResult }
}
