// src/config/project-manifest.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Network, Stack, ProjectConfig } from './model.js'
import { validBsvDir } from './validate.js'

export const MANIFEST_FILE = 'bsv-scaffold.json'

export interface ProjectManifest {
  version: 1
  name: string
  network: Network
  stack: Stack
  bsvDir: string
  capabilities: string[]
}

export function manifestFromConfig (config: ProjectConfig): ProjectManifest {
  return {
    version: 1,
    name: config.name,
    network: config.network,
    stack: config.stack,
    bsvDir: config.bsvDir,
    capabilities: [...config.capabilities]
  }
}

export function readProjectManifest (dir: string): ProjectManifest | null {
  const p = join(dir, MANIFEST_FILE)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectManifest
}

export function writeProjectManifest (dir: string, manifest: ProjectManifest): void {
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
}

export function mergeCapabilityIds (existing: string[], added: string[]): string[] {
  const out = [...existing]
  for (const id of added) if (!out.includes(id)) out.push(id)
  return out
}

export function remainingCapabilityIds (manifest: ProjectManifest, knownIds: string[]): string[] {
  return knownIds.filter(id => !manifest.capabilities.includes(id))
}

export function readValidManifest (dir: string): ProjectManifest | null {
  const m = readProjectManifest(dir)
  if (m === null) return null
  const stackOk = m.stack !== null && typeof m.stack === 'object' &&
    (m.stack.frontend == null || m.stack.frontend.framework === 'react') &&
    (m.stack.backend == null || m.stack.backend.framework === 'express')
  const ok = m.version === 1 && typeof m.name === 'string' &&
    (m.network === 'main' || m.network === 'test') &&
    stackOk &&
    typeof m.bsvDir === 'string' && validBsvDir(m.bsvDir) &&
    Array.isArray(m.capabilities) && m.capabilities.every(c => typeof c === 'string')
  if (!ok) throw new Error('malformed bsv-scaffold.json')
  return m
}
