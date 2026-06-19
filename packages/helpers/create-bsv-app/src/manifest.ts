// src/manifest.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Manifest, Selection } from './types.js'
import { listCapabilities } from './registry.js'

export const MANIFEST_FILE = 'bsv-scaffold.json'

export function manifestFromSelection (selection: Selection): Manifest {
  return {
    version: 1,
    name: selection.appName,
    network: selection.network,
    framework: selection.framework,
    capabilities: [...selection.capabilityIds]
  }
}

export function readManifest (dir: string): Manifest | null {
  const p = join(dir, MANIFEST_FILE)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as Manifest
}

export function writeManifest (dir: string, manifest: Manifest): void {
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
}

export function mergeCapabilityIds (existing: string[], added: string[]): string[] {
  const out = [...existing]
  for (const id of added) if (!out.includes(id)) out.push(id)
  return out
}

export function remainingCapabilityIds (manifest: Manifest): string[] {
  return listCapabilities().map(c => c.id).filter(id => !manifest.capabilities.includes(id))
}
