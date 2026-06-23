import type { ProjectConfig, PackageManager } from './config/model.js'
import type { TargetKey, WriteResult } from './engine.js'
import { writeFiles, planPlacement } from './engine.js'
import { resolveCapabilities } from './registry.js'
import { renderAgentsMd } from './agents-md.js'
import { manifestFromConfig, writeProjectManifest, readValidManifest } from './config/project-manifest.js'
import { resolveConfigFromFile } from './config/file.js'
import { resolveDraft, seedDraft, type ConfigDraft } from './config/draft.js'
import { scaffoldNewProject } from './scaffold/new-project.js'
import type { RunCommand } from './scaffold/base-scaffolder.js'
import type { ConfigProvider } from './prompts.js'

export interface CliArgs { dir?: string, file?: string, yes: boolean, force: boolean, draft: ConfigDraft }

export function parseArgs (argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false, draft: {} }
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
    } else if (a === '--glue') {
      args.draft.glue = true
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

export function addCapabilities (
  config: ProjectConfig,
  targetDir: string,
  opts: { force: boolean }
): { deps: Record<TargetKey, Record<string, string>> } & WriteResult {
  const caps = resolveCapabilities(config.capabilities)
  const placement = planPlacement(config, caps)
  const util = writeFiles(placement.utilFiles, targetDir, { force: opts.force })
  writeFiles(placement.glueFiles, targetDir, { force: true })
  writeFiles([{ path: 'AGENTS.md', content: renderAgentsMd(config, caps) }], targetDir, { force: true })
  writeProjectManifest(targetDir, manifestFromConfig(config))
  return { deps: placement.deps, written: util.written, skipped: util.skipped }
}

export async function run (
  argv: string[],
  provider?: ConfigProvider,
  deps?: { runCommand?: RunCommand }
): Promise<{ targetDir: string, deps: Record<TargetKey, Record<string, string>> } & WriteResult> {
  const args = parseArgs(argv)
  const targetDir = args.dir ?? '.'

  let config: ProjectConfig
  if (args.file !== undefined) {
    config = resolveConfigFromFile(args.file)
  } else {
    const existing = readValidManifest(targetDir)
    if (args.yes) {
      config = resolveDraft(seedDraft(existing, args.draft))
    } else {
      if (provider === undefined) throw new Error('interactive run requires a config provider')
      config = await provider({ existing, flags: args.draft })
    }
  }

  if (config.mode === 'new') {
    const r = scaffoldNewProject(config, targetDir, { runCommand: deps?.runCommand })
    return { targetDir, deps: r.deps, written: r.written, skipped: [] }
  }
  const r = addCapabilities(config, targetDir, { force: args.force })
  return { targetDir, deps: r.deps, written: r.written, skipped: r.skipped }
}
