// Transitional adapter. The interactive prompts and --ui still emit a `Selection`
// (a single framework); run() converts it to the canonical ProjectConfig here.
// There is NO released "legacy" format — `Selection` and this adapter are scaffolding,
// to be removed in Phase 4 once prompts build a ProjectConfig directly.
import type { Selection } from '../types.js'
import type { ProjectConfig } from './model.js'
import { resolveConfig } from './validate.js'

export function selectionToConfig (sel: Selection): ProjectConfig {
  // Route through resolveConfig so defaults (bsvDir, variant, packageManager, glue, dir)
  // have a single source of truth in validate.ts rather than being re-hardcoded here.
  return resolveConfig({
    mode: 'add',
    name: sel.appName,
    network: sel.network,
    stack: sel.framework === 'react'
      ? { frontend: { framework: 'react' } }
      : { backend: { framework: 'express' } },
    capabilities: sel.capabilityIds
  })
}
