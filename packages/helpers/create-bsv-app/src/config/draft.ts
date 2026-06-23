// src/config/draft.ts
import type { ProjectConfig, PackageManager, Network } from './model.js'
import type { ProjectManifest } from './project-manifest.js'
import { mergeCapabilityIds } from './project-manifest.js'
import { resolveConfig } from './validate.js'

export interface ConfigDraft {
  mode?: 'new' | 'add'
  name?: string
  frontend?: 'react' | 'none'
  frontendVariant?: string
  backend?: 'express' | 'none'
  bsvDir?: string
  capabilities?: string[]
  glue?: boolean
  packageManager?: PackageManager
  network?: Network
}

export function draftToConfigInput (d: ConfigDraft): Record<string, unknown> {
  const stack: Record<string, unknown> = {}
  if (d.frontend === 'react') stack.frontend = { framework: 'react', variant: d.frontendVariant ?? 'react-ts' }
  if (d.backend === 'express') stack.backend = { framework: 'express' }
  return {
    mode: d.mode,
    name: d.name,
    stack,
    bsvDir: d.bsvDir,
    capabilities: d.capabilities,
    glue: d.glue,
    packageManager: d.packageManager,
    network: d.network
  }
}

export function resolveDraft (d: ConfigDraft): ProjectConfig {
  return resolveConfig(draftToConfigInput(d))
}

export function seedDraft (existing: ProjectManifest | null, flags: ConfigDraft): ConfigDraft {
  const mode = flags.mode ?? (existing != null ? 'add' : 'new')
  if (mode === 'add' && existing != null) {
    return {
      mode: 'add',
      name: existing.name,
      frontend: existing.stack.frontend != null ? 'react' : 'none',
      frontendVariant: existing.stack.frontend?.variant,
      backend: existing.stack.backend != null ? 'express' : 'none',
      bsvDir: existing.bsvDir,
      network: existing.network,
      glue: flags.glue,
      packageManager: flags.packageManager,
      capabilities: mergeCapabilityIds(existing.capabilities, flags.capabilities ?? [])
    }
  }
  return { ...flags, mode: 'new' }
}
