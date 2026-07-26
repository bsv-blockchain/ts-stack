// src/engine.ts
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileSpec, Capability, CapabilityContext, Role } from './types.js'
import type { ProjectConfig, Layout } from './config/model.js'
import { layoutOf } from './config/model.js'
import { writeUtf8FileAtomic, writeUtf8FileExclusive } from './file-system.js'

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

function roleTargetsFor(layout: Layout): Record<Role, TargetKey[]> {
  switch (layout) {
    case 'frontend-only':
      return { shared: ['client'], client: ['client'], server: [] }
    case 'backend-only':
      return { shared: ['server'], client: [], server: ['server'] }
    case 'monorepo':
      return { shared: ['client', 'server'], client: ['client'], server: ['server'] }
    default:
      return { shared: [], client: [], server: [] }
  }
}

const joinRel = (...parts: string[]): string => parts.filter(p => p.length > 0).join('/')

type AddFile = (map: Map<string, FileSpec>, path: string, content: string) => void

interface FilePlacementState {
  config: ProjectConfig
  ctx: CapabilityContext
  roleTargets: Record<Role, TargetKey[]>
  bsvDir: string
  utilByPath: Map<string, FileSpec>
  deps: Record<TargetKey, Record<string, string>>
  add: AddFile
}

function placeCapabilityFiles(cap: Capability, state: FilePlacementState): void {
  const roleFiles = cap.files(state.ctx)
  const roleDeps = cap.npmDependencies(state.ctx)
  for (const role of ROLES) {
    const targets = state.roleTargets[role]
    if (targets.length === 0) continue
    const files = roleFiles[role] ?? []
    const rdeps = roleDeps[role] ?? {}
    for (const t of targets) {
      for (const f of files)
        state.add(
          state.utilByPath,
          joinRel(targetRoot(state.config, t), state.bsvDir, f.path),
          f.content
        )
      Object.assign(state.deps[t], rdeps)
    }
  }
}

function placeCapabilityGlue(
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
      for (const f of glue[role] ?? [])
        add(glueByPath, joinRel(targetRoot(config, t), f.path), f.content)
    }
  }
}

export function planPlacement(config: ProjectConfig, capabilities: Capability[]): PlacementResult {
  const layout = layoutOf(config.stack)
  const ctx: CapabilityContext = {
    name: config.name,
    network: config.network,
    bsvDir: config.bsvDir,
    stack: config.stack,
    layout
  }
  const roleTargets = roleTargetsFor(layout)
  const utilByPath = new Map<string, FileSpec>()
  const glueByPath = new Map<string, FileSpec>()
  const deps: Record<TargetKey, Record<string, string>> = { root: {}, client: {}, server: {} }

  const add: AddFile = (map, path, content) => {
    const existing = map.get(path)
    if (existing != null && existing.content !== content)
      throw new Error(`file conflict at ${path} between capabilities`)
    map.set(path, { path, content })
  }
  const filePlacement: FilePlacementState = {
    config,
    ctx,
    roleTargets,
    bsvDir: config.bsvDir,
    utilByPath,
    deps,
    add
  }

  for (const cap of capabilities) {
    placeCapabilityFiles(cap, filePlacement)
    if (config.glue) placeCapabilityGlue(cap, config, ctx, roleTargets, glueByPath, add)
  }
  return { utilFiles: [...utilByPath.values()], glueFiles: [...glueByPath.values()], deps }
}

export interface WriteResult {
  written: string[]
  skipped: string[]
}

export function writeFiles(
  specs: FileSpec[],
  targetDir: string,
  opts: { force?: boolean } = {}
): WriteResult {
  const written: string[] = []
  const skipped: string[] = []
  for (const spec of specs) {
    const abs = join(targetDir, spec.path)
    mkdirSync(dirname(abs), { recursive: true })
    if (opts.force === true) {
      writeUtf8FileAtomic(abs, spec.content)
    } else if (!writeUtf8FileExclusive(abs, spec.content)) {
      skipped.push(spec.path)
      continue
    }
    written.push(spec.path)
  }
  return { written, skipped }
}
