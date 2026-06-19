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
