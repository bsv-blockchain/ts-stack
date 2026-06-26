import type { ProjectConfig, PackageManager } from './config/model.js'
import { readValidManifest, type ProjectManifest } from './config/project-manifest.js'
import { resolveConfigFromFile } from './config/file.js'
import { resolveDraft, seedDraft, type ConfigDraft } from './config/draft.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'
import type { ConfigProvider } from './prompts.js'
import { applyConfig, type RunResult } from './pipeline.js'

export type StartUi = (opts: { existing: ProjectManifest | null, targetDir: string, runCommand?: RunCommand }) => Promise<RunResult>

export interface CliArgs { dir?: string, file?: string, yes: boolean, force: boolean, ui: boolean, draft: ConfigDraft }

export function parseArgs (argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false, ui: false, draft: {} }
  const next = (i: number): [string | undefined, number] => [argv[i + 1], i + 1]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') {
      [args.dir, i] = next(i)
    } else if (a === '--file') {
      [args.file, i] = next(i)
    } else if (a === '--yes') {
      args.yes = true
    } else if (a === '--force') {
      args.force = true
    } else if (a === '--ui') {
      args.ui = true
    } else if (a === '--glue') {
      args.draft.glue = true
    } else if (a === '--no-glue') {
      args.draft.glue = false
    } else if (a === '--mode') {
      const [v, j] = next(i); i = j
      args.draft.mode = v === 'add' ? 'add' : 'new'
    } else if (a === '--name') {
      const [v, j] = next(i); i = j
      args.draft.name = v
    } else if (a === '--frontend') {
      const [v, j] = next(i); i = j
      args.draft.frontend = v === 'react' ? 'react' : 'none'
    } else if (a === '--backend') {
      const [v, j] = next(i); i = j
      args.draft.backend = v === 'express' ? 'express' : 'none'
    } else if (a === '--variant') {
      const [v, j] = next(i); i = j
      args.draft.frontendVariant = v
    } else if (a === '--bsv-dir') {
      const [v, j] = next(i); i = j
      args.draft.bsvDir = v
    } else if (a === '--capabilities') {
      const [v, j] = next(i); i = j
      args.draft.capabilities = (v ?? '').split(',').filter(Boolean)
    } else if (a === '--package-manager') {
      const [v, j] = next(i); i = j
      args.draft.packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(v ?? '') ? v as PackageManager : undefined
    } else if (a === '--network') {
      const [v, j] = next(i); i = j
      args.draft.network = v === 'main' ? 'main' : 'test'
    } else if (args.dir === undefined && !a.startsWith('--')) {
      args.dir = a
    }
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
  if (args.file !== undefined) {
    // The file is the source of truth, but an explicit --mode flag overrides its "mode".
    config = resolveConfigFromFile(args.file, { overrideMode: args.draft.mode })
  } else {
    const existing = readValidManifest(targetDir)
    if (args.yes) {
      config = resolveDraft(seedDraft(existing, args.draft))
    } else {
      if (provider === undefined) throw new Error('interactive run requires a config provider')
      config = await provider({ existing, flags: args.draft })
    }
  }

  return applyConfig(config, targetDir, { runCommand: deps?.runCommand, force: args.force })
}
