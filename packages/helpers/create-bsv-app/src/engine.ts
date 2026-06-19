// src/engine.ts
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileSpec, GenContext, Selection } from './types.js'
import { getCapability } from './registry.js'

function ctxOf (selection: Selection): GenContext {
  return { appName: selection.appName, network: selection.network, framework: selection.framework }
}

function expandIds (ids: string[]): string[] {
  const out: string[] = []
  const visit = (id: string): void => {
    const c = getCapability(id)
    if (c == null) throw new Error(`unknown capability: ${id}`)
    for (const dep of c.requires ?? []) visit(dep)
    if (!out.includes(id)) out.push(id)
  }
  for (const id of ids) visit(id)
  return out
}

export function planFiles (selection: Selection): FileSpec[] {
  const ctx = ctxOf(selection)
  const byPath = new Map<string, FileSpec>()
  for (const id of expandIds(selection.capabilityIds)) {
    const cap = getCapability(id)
    if (cap == null) throw new Error(`unknown capability: ${id}`)
    for (const spec of cap.files(ctx)) {
      const existing = byPath.get(spec.path)
      if (existing != null && existing.content !== spec.content) {
        throw new Error(`file conflict at ${spec.path} between capabilities`)
      }
      byPath.set(spec.path, spec)
    }
  }
  return [...byPath.values()]
}

export function aggregateDependencies (selection: Selection): Record<string, string> {
  const ctx = ctxOf(selection)
  const deps: Record<string, string> = {}
  for (const id of expandIds(selection.capabilityIds)) {
    const cap = getCapability(id)
    if (cap == null) throw new Error(`unknown capability: ${id}`)
    Object.assign(deps, cap.npmDependencies(ctx))
  }
  return deps
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
