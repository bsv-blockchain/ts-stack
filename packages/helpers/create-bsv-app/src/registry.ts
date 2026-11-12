// src/registry.ts
import type { Capability } from './types.js'
import type { Layout } from './config/model.js'
import { layoutHasRole } from './engine.js'
import { walletConnect } from './capabilities/wallet-connect.js'
import { walletLogin } from './capabilities/wallet-login.js'
import { signedRequests } from './capabilities/signed-requests.js'
import { txCore } from './capabilities/tx-core.js'

export const registry: Capability[] = [walletConnect, walletLogin, signedRequests, txCore]

export function listCapabilities(): Capability[] {
  return registry
}

export function getCapability(id: string): Capability | undefined {
  return registry.find(c => c.id === id)
}

/** Ids `cap` requires in `layout`: plain entries always, role-scoped ones where the role is placed. */
export function requiredIds(cap: Capability, layout: Layout): string[] {
  return (cap.requires ?? [])
    .filter(r => typeof r === 'string' || layoutHasRole(layout, r.role))
    .map(r => (typeof r === 'string' ? r : r.id))
}

/** `layout` scopes role-scoped requirements; it is required so no caller expands layout-blind. */
export function resolveCapabilities(
  ids: string[],
  opts: { layout: Layout; expandRequires?: boolean }
): Capability[] {
  const expand = opts.expandRequires !== false
  const { layout } = opts
  const out: Capability[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    const c = getCapability(id)
    if (c === undefined) throw new Error(`unknown capability: ${id}`)
    if (expand) for (const dep of requiredIds(c, layout)) visit(dep)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(c)
    }
  }
  for (const id of ids) visit(id)
  return out
}
