// src/config/draft.ts
import type { ProjectConfig, PackageManager, Network, TargetPaths } from './model.js'
import type { ProjectManifest } from './project-manifest.js'
import { mergeCapabilityIds } from './project-manifest.js'
import { listCapabilities } from '../registry.js'
import { getStarter } from '../starters.js'
import { resolveConfig } from './validate.js'

export interface ConfigDraft {
  mode?: 'new' | 'add'
  name?: string
  starter?: string
  frontend?: 'react' | 'none'
  frontendVariant?: string
  backend?: 'express' | 'none'
  bsvDir?: string
  capabilities?: string[]
  glue?: boolean
  install?: boolean
  packageManager?: PackageManager
  network?: Network
  targets?: TargetPaths
}

export function draftToConfigInput (d: ConfigDraft): Record<string, unknown> {
  const stack: Record<string, unknown> = {}
  if (d.frontend === 'react') stack.frontend = { framework: 'react', variant: d.frontendVariant ?? 'react-ts' }
  if (d.backend === 'express') stack.backend = { framework: 'express' }
  return {
    mode: d.mode,
    name: d.name,
    starter: d.starter,
    stack,
    targets: d.targets,
    bsvDir: d.bsvDir,
    capabilities: d.capabilities,
    glue: d.glue,
    install: d.install,
    packageManager: d.packageManager,
    network: d.network
  }
}

export function resolveDraft (d: ConfigDraft): ProjectConfig {
  return resolveConfig(draftToConfigInput(d))
}

export function seedDraft (existing: ProjectManifest | null, flags: ConfigDraft): ConfigDraft {
  const mode = flags.mode ?? (existing == null ? 'new' : 'add')
  if (mode === 'add' && existing != null) {
    return {
      mode: 'add',
      name: existing.name,
      starter: existing.starter?.id ?? 'custom',
      frontend: existing.stack.frontend == null ? 'none' : 'react',
      frontendVariant: existing.stack.frontend?.variant,
      backend: existing.stack.backend == null ? 'none' : 'express',
      bsvDir: existing.bsvDir,
      network: existing.network,
      glue: flags.glue,
      install: flags.install,
      packageManager: flags.packageManager,
      capabilities: mergeCapabilityIds(existing.capabilities, flags.capabilities ?? []),
      targets: existing.targets
    }
  }
  const starter = flags.starter ?? 'custom'
  const defaults = getStarter(starter)?.supportsCapabilities === true
    ? listCapabilities().filter(capability => capability.defaultSelected).map(capability => capability.id)
    : []
  return {
    ...flags,
    mode,
    starter,
    capabilities: mergeCapabilityIds(defaults, flags.capabilities ?? [])
  }
}
