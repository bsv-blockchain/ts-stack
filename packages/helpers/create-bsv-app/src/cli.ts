import type { ProjectConfig, PackageManager } from './config/model.js'
import { readValidManifest, type ProjectManifest } from './config/project-manifest.js'
import { resolveConfigFromFile } from './config/file.js'
import { resolveDraft, seedDraft, type ConfigDraft } from './config/draft.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'
import type { ConfigProvider } from './prompts.js'
import { applyConfig, type RunResult } from './pipeline.js'

export type StartUi = (opts: { existing: ProjectManifest | null, targetDir: string, runCommand?: RunCommand }) => Promise<RunResult>

export interface CliArgs { dir?: string, file?: string, yes: boolean, force: boolean, ui: boolean, draft: ConfigDraft }

type ValueFlagHandler = (args: CliArgs, value: string | undefined) => void
type BooleanFlagHandler = (args: CliArgs) => void

const VALUE_FLAGS: Record<string, ValueFlagHandler> = {
  '--dir': (args, v) => { args.dir = v },
  '--file': (args, v) => { args.file = v },
  '--mode': (args, v) => { args.draft.mode = v === 'add' ? 'add' : 'new' },
  '--name': (args, v) => { args.draft.name = v },
  '--frontend': (args, v) => { args.draft.frontend = v === 'react' ? 'react' : 'none' },
  '--backend': (args, v) => { args.draft.backend = v === 'express' ? 'express' : 'none' },
  '--variant': (args, v) => { args.draft.frontendVariant = v },
  '--bsv-dir': (args, v) => { args.draft.bsvDir = v },
  '--capabilities': (args, v) => { args.draft.capabilities = (v ?? '').split(',').filter(Boolean) },
  '--package-manager': (args, v) => {
    args.draft.packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(v ?? '') ? v as PackageManager : undefined
  },
  '--network': (args, v) => { args.draft.network = v === 'main' ? 'main' : 'test' }
}

const BOOLEAN_FLAGS: Record<string, BooleanFlagHandler> = {
  '--yes': (args) => { args.yes = true },
  '--force': (args) => { args.force = true },
  '--ui': (args) => { args.ui = true },
  '--glue': (args) => { args.draft.glue = true },
  '--no-glue': (args) => { args.draft.glue = false }
}

export function parseArgs (argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false, ui: false, draft: {} }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a in VALUE_FLAGS) {
      VALUE_FLAGS[a](args, argv[i + 1])
      i += 2
      continue
    }
    if (a in BOOLEAN_FLAGS) {
      BOOLEAN_FLAGS[a](args)
      i += 1
      continue
    }
    if (args.dir === undefined && !a.startsWith('--')) args.dir = a
    i += 1
  }
  return args
}

export async function run (
  argv: string[],
  provider?: ConfigProvider,
  deps?: { runCommand?: RunCommand, startUi?: StartUi }
): Promise<RunResult> {
  const args = parseArgs(argv)
  const targetDir = args.dir ?? '.'

  if (args.ui) {
    const existing = readValidManifest(targetDir)
    const startUi = deps?.startUi ?? (async (o: { existing: ProjectManifest | null, targetDir: string, runCommand?: RunCommand }) => { return await (await import('./ui/ui-server.js')).runUi(o) })
    return await startUi({ existing, targetDir, runCommand: deps?.runCommand })
  }

  let config: ProjectConfig
  if (args.file === undefined) {
    const existing = readValidManifest(targetDir)
    if (args.yes) {
      config = resolveDraft(seedDraft(existing, args.draft))
    } else {
      if (provider === undefined) throw new Error('interactive run requires a config provider')
      config = await provider({ existing, flags: args.draft })
    }
  } else {
    // The file is the source of truth, but an explicit --mode flag overrides its "mode".
    config = resolveConfigFromFile(args.file, { overrideMode: args.draft.mode })
  }

  return applyConfig(config, targetDir, { runCommand: deps?.runCommand, force: args.force })
}
