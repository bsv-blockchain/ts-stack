import { basename, resolve } from 'node:path'
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

export type StartUi = (opts: {
  existing: ProjectManifest | null
  targetDir: string
  runCommand?: RunCommand
}) => Promise<RunResult>

export interface CliArgs {
  dir?: string
  file?: string
  yes: boolean
  force: boolean
  ui: boolean
  draft: ConfigDraft
}

export const CLI_HELP = `Usage: create-bsv-app [new|add] [directory] [options]

Create a new BSV application or add capabilities to an existing project.

Options:
  --dir <path>                 Target directory
  --file <path>                Read configuration from a JSON file
  --mode <new|add>             Set the scaffold mode
  --name <name>                Set the project name
  --starter <name>             Select a registered starter
  --frontend <react|none>      Select the frontend
  --backend <express|none>     Select the backend
  --variant <name>             Select the frontend variant
  --bsv-dir <path>             Set the generated BSV module directory
  --capabilities <names>       Add comma-separated BSV capabilities
  --package-manager <name>     Use npm, pnpm, yarn, or bun
  --network <main|test>        Select the BSV network
  --yes                        Accept defaults without prompting
  --force                      Overwrite conflicting generated files
  --ui                         Open the browser-based configurator
  --glue | --no-glue          Enable or disable integration glue
  --install | --skip-install  Enable or disable dependency installation
  -h, --help                   Show this help
`

type ValueFlagHandler = (args: CliArgs, value: string | undefined) => void
type BooleanFlagHandler = (args: CliArgs) => void

const VALUE_FLAGS: Record<string, ValueFlagHandler> = {
  '--dir': (args, v) => {
    args.dir = v
  },
  '--file': (args, v) => {
    args.file = v
  },
  '--mode': (args, v) => {
    if (v !== 'new' && v !== 'add') throw new ConfigError('--mode must be new or add')
    args.draft.mode = v
  },
  '--name': (args, v) => {
    args.draft.name = v
  },
  '--starter': (args, v) => {
    if (v == null || getStarter(v) === undefined)
      throw new ConfigError(`unknown starter: ${String(v)}`)
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
  '--variant': (args, v) => {
    args.draft.frontendVariant = v
  },
  '--bsv-dir': (args, v) => {
    args.draft.bsvDir = v
  },
  '--capabilities': (args, v) => {
    args.draft.capabilities = (v ?? '').split(',').filter(Boolean)
  },
  '--package-manager': (args, v) => {
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(v ?? ''))
      throw new ConfigError('--package-manager must be npm, pnpm, yarn, or bun')
    args.draft.packageManager = v as PackageManager
  },
  '--network': (args, v) => {
    if (v !== 'main' && v !== 'test') throw new ConfigError('--network must be main or test')
    args.draft.network = v
  }
}

const BOOLEAN_FLAGS: Record<string, BooleanFlagHandler> = {
  '--yes': args => {
    args.yes = true
  },
  '--force': args => {
    args.force = true
  },
  '--ui': args => {
    args.ui = true
  },
  '--glue': args => {
    args.draft.glue = true
  },
  '--no-glue': args => {
    args.draft.glue = false
  },
  '--install': args => {
    args.draft.install = true
  },
  '--skip-install': args => {
    args.draft.install = false
  }
}

function assignModeOrTarget(args: CliArgs, token: string): void {
  if (token === 'new' || token === 'add') {
    if (args.draft.mode !== undefined && args.draft.mode !== token)
      throw new ConfigError('conflicting mode arguments')
    args.draft.mode = token
    return
  }
  if (token.startsWith('--')) throw new ConfigError(`unknown option: ${token}`)
  if (args.dir !== undefined) throw new ConfigError(`unexpected argument: ${token}`)
  args.dir = token
}

function consumeArgument(args: CliArgs, argv: string[], index: number): number {
  const token = argv[index]
  const valueHandler = VALUE_FLAGS[token]
  if (valueHandler !== undefined) {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--'))
      throw new ConfigError(`${token} requires a value`)
    valueHandler(args, value)
    return 2
  }

  const booleanHandler = BOOLEAN_FLAGS[token]
  if (booleanHandler !== undefined) {
    booleanHandler(args)
    return 1
  }

  assignModeOrTarget(args, token)
  return 1
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false, ui: false, draft: {} }
  let i = 0
  while (i < argv.length) i += consumeArgument(args, argv, i)
  return args
}

function existingProject(targetDir: string): ProjectManifest | null {
  return readValidManifest(targetDir) ?? detectExistingProject(targetDir)
}

function flagsWithDefaultName(
  args: CliArgs,
  existing: ProjectManifest | null,
  targetDir: string
): ConfigDraft {
  const flags = { ...args.draft }
  const mode = flags.mode ?? (existing == null ? 'new' : 'add')
  if (mode === 'new' && flags.name === undefined) flags.name = basename(resolve(targetDir))
  return flags
}

async function resolveCliConfig(
  args: CliArgs,
  targetDir: string,
  provider?: ConfigProvider
): Promise<ProjectConfig> {
  if (args.file !== undefined) {
    return resolveConfigFromFile(args.file, { overrideMode: args.draft.mode })
  }

  const existing = existingProject(targetDir)
  if (args.yes)
    return resolveDraft(seedDraft(existing, flagsWithDefaultName(args, existing, targetDir)))
  if (provider === undefined) throw new Error('interactive run requires a config provider')
  return await provider({ existing, flags: args.draft })
}

export async function run(
  argv: string[],
  provider?: ConfigProvider,
  deps?: { runCommand?: RunCommand; startUi?: StartUi }
): Promise<RunResult> {
  const args = parseArgs(argv)
  const initialTargetDir = args.dir ?? '.'

  if (args.ui) {
    const existing = existingProject(initialTargetDir)
    const startUi =
      deps?.startUi ??
      (async (o: {
        existing: ProjectManifest | null
        targetDir: string
        runCommand?: RunCommand
      }) => {
        return await (await import('./ui/ui-server.js')).runUi(o)
      })
    return await startUi({ existing, targetDir: initialTargetDir, runCommand: deps?.runCommand })
  }

  const config = await resolveCliConfig(args, initialTargetDir, provider)
  const targetDir = args.dir ?? config.dir
  return applyConfig(config, targetDir, { runCommand: deps?.runCommand, force: args.force })
}
