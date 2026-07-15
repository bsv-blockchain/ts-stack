import type { ProjectConfig, PackageManager } from './config/model.js'
import { readValidManifest, type ProjectManifest } from './config/project-manifest.js'
import { detectExistingProject } from './config/detect.js'
import { resolveConfigFromFile } from './config/file.js'
import { resolveDraft, seedDraft, type ConfigDraft } from './config/draft.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'
import type { ConfigProvider } from './prompts.js'
import { applyConfig, type RunResult } from './pipeline.js'
import { ConfigError } from './config/validate.js'
import { getStarter } from './starters.js'
import { basename, resolve } from 'node:path'

export type StartUi = (opts: { existing: ProjectManifest | null, targetDir: string, runCommand?: RunCommand }) => Promise<RunResult>

export interface CliArgs { dir?: string, file?: string, yes: boolean, force: boolean, ui: boolean, draft: ConfigDraft }

type ValueFlagHandler = (args: CliArgs, value: string | undefined) => void
type BooleanFlagHandler = (args: CliArgs) => void

const VALUE_FLAGS: Record<string, ValueFlagHandler> = {
  '--dir': (args, v) => { args.dir = v },
  '--file': (args, v) => { args.file = v },
  '--mode': (args, v) => {
    if (v !== 'new' && v !== 'add') throw new ConfigError('--mode must be new or add')
    args.draft.mode = v
  },
  '--name': (args, v) => { args.draft.name = v },
  '--starter': (args, v) => {
    if (v == null || getStarter(v) === undefined) throw new ConfigError(`unknown starter: ${String(v)}`)
    args.draft.starter = v
  },
  '--frontend': (args, v) => {
    if (v !== 'react' && v !== 'none') throw new ConfigError('--frontend must be react or none')
    args.draft.frontend = v
  },
  '--backend': (args, v) => {
    if (v !== 'express' && v !== 'none') throw new ConfigError('--backend must be express or none')
    args.draft.backend = v
  },
  '--variant': (args, v) => { args.draft.frontendVariant = v },
  '--bsv-dir': (args, v) => { args.draft.bsvDir = v },
  '--capabilities': (args, v) => { args.draft.capabilities = (v ?? '').split(',').filter(Boolean) },
  '--package-manager': (args, v) => {
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(v ?? '')) throw new ConfigError('--package-manager must be npm, pnpm, yarn, or bun')
    args.draft.packageManager = v as PackageManager
  },
  '--network': (args, v) => {
    if (v !== 'main' && v !== 'test') throw new ConfigError('--network must be main or test')
    args.draft.network = v
  }
}

const BOOLEAN_FLAGS: Record<string, BooleanFlagHandler> = {
  '--yes': (args) => { args.yes = true },
  '--force': (args) => { args.force = true },
  '--ui': (args) => { args.ui = true },
  '--glue': (args) => { args.draft.glue = true },
  '--no-glue': (args) => { args.draft.glue = false },
  '--install': (args) => { args.draft.install = true },
  '--skip-install': (args) => { args.draft.install = false }
}

export function parseArgs (argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false, ui: false, draft: {} }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a in VALUE_FLAGS) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new ConfigError(`${a} requires a value`)
      VALUE_FLAGS[a](args, argv[i + 1])
      i += 2
      continue
    }
    if (a in BOOLEAN_FLAGS) {
      BOOLEAN_FLAGS[a](args)
      i += 1
      continue
    }
    if (a === 'new' || a === 'add') {
      if (args.draft.mode !== undefined && args.draft.mode !== a) throw new ConfigError('conflicting mode arguments')
      args.draft.mode = a
      i += 1
      continue
    }
    if (a.startsWith('--')) throw new ConfigError(`unknown option: ${a}`)
    if (args.dir === undefined) args.dir = a
    else throw new ConfigError(`unexpected argument: ${a}`)
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
  const initialTargetDir = args.dir ?? '.'

  if (args.ui) {
    const existing = readValidManifest(initialTargetDir) ?? detectExistingProject(initialTargetDir)
    const startUi = deps?.startUi ?? (async (o: { existing: ProjectManifest | null, targetDir: string, runCommand?: RunCommand }) => { return await (await import('./ui/ui-server.js')).runUi(o) })
    return await startUi({ existing, targetDir: initialTargetDir, runCommand: deps?.runCommand })
  }

  let config: ProjectConfig
  if (args.file === undefined) {
    const existing = readValidManifest(initialTargetDir) ?? detectExistingProject(initialTargetDir)
    if (args.yes) {
      const flags = { ...args.draft }
      if ((flags.mode ?? (existing == null ? 'new' : 'add')) === 'new' && flags.name === undefined) {
        flags.name = basename(resolve(initialTargetDir))
      }
      config = resolveDraft(seedDraft(existing, flags))
    } else {
      if (provider === undefined) throw new Error('interactive run requires a config provider')
      config = await provider({ existing, flags: args.draft })
    }
  } else {
    // The file is the source of truth, but an explicit --mode flag overrides its "mode".
    config = resolveConfigFromFile(args.file, { overrideMode: args.draft.mode })
  }

  const targetDir = args.dir ?? config.dir
  return applyConfig(config, targetDir, { runCommand: deps?.runCommand, force: args.force })
}
