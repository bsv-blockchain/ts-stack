// src/registry.ts
import type { Capability } from './types.js'
import { walletConnect } from './capabilities/wallet-connect.js'
import { walletLogin } from './capabilities/wallet-login.js'
import { signedRequests } from './capabilities/signed-requests.js'

export const registry: Capability[] = [walletConnect, walletLogin, signedRequests]

export function listCapabilities(): Capability[] {
  return registry
}

export function getCapability(id: string): Capability | undefined {
  return registry.find(c => c.id === id)
}

export function resolveCapabilities(
  ids: string[],
  opts: { expandRequires?: boolean } = {}
): Capability[] {
  const expand = opts.expandRequires !== false
  const out: Capability[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    const c = getCapability(id)
    if (c === undefined) throw new Error(`unknown capability: ${id}`)
    if (expand) for (const dep of c.requires ?? []) visit(dep)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(c)
    }
  }
  for (const id of ids) visit(id)
  return out
}
