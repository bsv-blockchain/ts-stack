import {
  WalletClient,
  WalletInterface,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import { WalletCore } from './core/WalletCore'
import { WalletDefaults } from './core/types'
import { createTokenMethods } from './modules/tokens'
import { createInscriptionMethods } from './modules/inscriptions'
import { createMessageBoxMethods } from './modules/messagebox'
import { createCertificationMethods } from './modules/certification'
import { createOverlayMethods } from './modules/overlay'
import { createDIDMethods } from './modules/did'
import { createCredentialMethods } from './modules/credentials'

// ============================================================================
// BrowserWallet extends WalletCore with WalletClient
// ============================================================================

class BrowserWalletCore extends WalletCore {
  private readonly client: WalletClient

  constructor(client: WalletClient, identityKey: string, defaults?: Partial<WalletDefaults>) {
    super(identityKey, defaults)
    this.client = client
  }

  getClient(): WalletInterface {
    return this.client as unknown as WalletInterface
  }
}

// ============================================================================
// Composed BrowserWallet type (base + all modules)
// ============================================================================

export type BrowserWallet = BrowserWalletCore &
  ReturnType<typeof createTokenMethods> &
  ReturnType<typeof createInscriptionMethods> &
  ReturnType<typeof createMessageBoxMethods> &
  ReturnType<typeof createCertificationMethods> &
  ReturnType<typeof createOverlayMethods> &
  ReturnType<typeof createDIDMethods> &
  ReturnType<typeof createCredentialMethods>

// ============================================================================
// Factory function
// ============================================================================

export async function createWallet(defaults?: Partial<WalletDefaults>): Promise<BrowserWallet> {
  const client = new WalletClient('auto', 'simple')
  const request = { identityKey: true } as const
  validateWalletArgs('getPublicKey', request)
  const binding = snapshotWalletResultRequest('getPublicKey', request)
  const { publicKey } = validateWalletResult(
    'getPublicKey',
    await client.getPublicKey(request),
    binding
  )
  const wallet = new BrowserWalletCore(client, publicKey, defaults)

  Object.assign(wallet, createTokenMethods(wallet))
  Object.assign(wallet, createInscriptionMethods(wallet))
  Object.assign(wallet, createMessageBoxMethods(wallet))
  Object.assign(wallet, createCertificationMethods(wallet))
  Object.assign(wallet, createOverlayMethods(wallet))
  Object.assign(wallet, createDIDMethods(wallet))
  Object.assign(wallet, createCredentialMethods(wallet))

  return wallet as BrowserWallet
}

// ============================================================================
// Re-exports
// ============================================================================

export type { BrowserWallet as Wallet }
export { Overlay } from './modules/overlay'
export { Certifier } from './modules/certification'
export { WalletCore } from './core/WalletCore'
export { DID } from './modules/did'
export { CredentialSchema, CredentialIssuer, MemoryRevocationStore } from './modules/credentials'

export type { DidDocument, DidResolutionResult } from '@bsv/did'
export type { BRC52Envelope, BRC52VerificationResult } from '@bsv/did/brc52'
export type { IssuedCredential } from './modules/credentials'
