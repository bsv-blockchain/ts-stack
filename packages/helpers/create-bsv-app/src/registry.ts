// src/registry.ts
import type { Capability } from './types.js'
import { walletLogin } from './capabilities/wallet-login.js'

export const registry: Capability[] = [walletLogin]

export function listCapabilities (): Capability[] {
  return registry
}

export function getCapability (id: string): Capability | undefined {
  return registry.find(c => c.id === id)
}

export function resolveCapabilities (ids: string[]): Capability[] {
  const out: Capability[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    const c = getCapability(id)
    if (c === undefined) throw new Error(`unknown capability: ${id}`)
    for (const dep of c.requires ?? []) visit(dep)
    if (!seen.has(id)) { seen.add(id); out.push(c) }
  }
  for (const id of ids) visit(id)
  return out
}
