// src/capabilities/versions.ts
// Dependency ranges written into generated apps. Single source for all capabilities.
export const BSV_SDK_RANGE = '^4.0.1'
export const BSV_AUTH_RANGE = '^0.1.8'
export const WALLET_RELAY_RANGE = '^0.7.0'
export const WALLET_HELPER_RANGE = '^0.1.11'

/** The packages whose ranges come from this file: owned here, so add mode may raise them across a major. */
export const OWNED_PACKAGES: ReadonlySet<string> = new Set([
  '@bsv/sdk',
  '@bsv/auth',
  '@bsv/wallet-relay',
  '@bsv/wallet-helper'
])
