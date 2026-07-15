// src/engine.ts
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileSpec, Capability, CapabilityContext, Role } from './types.js'
import type { ProjectConfig, Layout } from './config/model.js'
import { layoutOf } from './config/model.js'

export type TargetKey = 'root' | 'client' | 'server'
export interface PlacementResult {
  utilFiles: FileSpec[]
  glueFiles: FileSpec[]
  deps: Record<TargetKey, Record<string, string>>
}

const ROLES: Role[] = ['shared', 'client', 'server']
const targetRoot = (config: ProjectConfig, t: TargetKey): string => {
  if (t === 'root') return ''
  return config.targets[t] ?? t
}

function roleTargetsFor (layout: Layout): Record<Role, TargetKey[]> {
  switch (layout) {
    case 'frontend-only': return { shared: ['client'], client: ['client'], server: [] }
    case 'backend-only': return { shared: ['server'], client: [], server: ['server'] }
    case 'monorepo': return { shared: ['client', 'server'], client: ['client'], server: ['server'] }
    default: return { shared: [], client: [], server: [] }
  }
}

const joinRel = (...parts: string[]): string => parts.filter(p => p.length > 0).join('/')

type AddFile = (map: Map<string, FileSpec>, path: string, content: string) => void

function placeCapabilityFiles (
  cap: Capability,
  config: ProjectConfig,
  ctx: CapabilityContext,
  roleTargets: Record<Role, TargetKey[]>,
  bsvDir: string,
  utilByPath: Map<string, FileSpec>,
  deps: Record<TargetKey, Record<string, string>>,
  add: AddFile
): void {
  const roleFiles = cap.files(ctx)
  const roleDeps = cap.npmDependencies(ctx)
  for (const role of ROLES) {
    const targets = roleTargets[role]
    if (targets.length === 0) continue
    const files = roleFiles[role] ?? []
    const rdeps = roleDeps[role] ?? {}
    for (const t of targets) {
      for (const f of files) add(utilByPath, joinRel(targetRoot(config, t), bsvDir, f.path), f.content)
      Object.assign(deps[t], rdeps)
    }
  }
}

function placeCapabilityGlue (
  cap: Capability,
  config: ProjectConfig,
  ctx: CapabilityContext,
  roleTargets: Record<Role, TargetKey[]>,
  glueByPath: Map<string, FileSpec>,
  add: AddFile
): void {
  if (cap.glue == null) return
  const glue = cap.glue(ctx)
  for (const role of ROLES) {
    for (const t of roleTargets[role]) {
      for (const f of glue[role] ?? []) add(glueByPath, joinRel(targetRoot(config, t), f.path), f.content)
    }
  }
}

export function planPlacement (config: ProjectConfig, capabilities: Capability[]): PlacementResult {
  const layout = layoutOf(config.stack)
  const ctx: CapabilityContext = { name: config.name, network: config.network, bsvDir: config.bsvDir, stack: config.stack, layout }
  const roleTargets = roleTargetsFor(layout)
  const utilByPath = new Map<string, FileSpec>()
  const glueByPath = new Map<string, FileSpec>()
  const deps: Record<TargetKey, Record<string, string>> = { root: {}, client: {}, server: {} }

  const add: AddFile = (map, path, content) => {
    const existing = map.get(path)
    if (existing != null && existing.content !== content) throw new Error(`file conflict at ${path} between capabilities`)
    map.set(path, { path, content })
  }

  for (const cap of capabilities) {
    placeCapabilityFiles(cap, config, ctx, roleTargets, config.bsvDir, utilByPath, deps, add)
    if (config.glue) placeCapabilityGlue(cap, config, ctx, roleTargets, glueByPath, add)
  }
  return { utilFiles: [...utilByPath.values()], glueFiles: [...glueByPath.values()], deps }
}

export interface WriteResult { written: string[], skipped: string[] }

export function writeFiles (specs: FileSpec[], targetDir: string, opts: { force?: boolean } = {}): WriteResult {
  const written: string[] = []
  const skipped: string[] = []
  for (const spec of specs) {
    const abs = join(targetDir, spec.path)
    const exists: boolean = existsSync(abs)
    const shouldSkip: boolean = exists && opts.force !== true
    if (shouldSkip) {
      skipped.push(spec.path)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, spec.content)
    written.push(spec.path)
  }
  return { written, skipped }
}
