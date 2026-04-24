import { WalletClient, WalletInterface } from '@bsv/sdk'
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

class _BrowserWallet extends WalletCore {
  private client: WalletClient

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

export type BrowserWallet = _BrowserWallet
  & ReturnType<typeof createTokenMethods>
  & ReturnType<typeof createInscriptionMethods>
  & ReturnType<typeof createMessageBoxMethods>
  & ReturnType<typeof createCertificationMethods>
  & ReturnType<typeof createOverlayMethods>
  & ReturnType<typeof createDIDMethods>
  & ReturnType<typeof createCredentialMethods>

// ============================================================================
// Factory function
// ============================================================================

export async function createWallet(defaults?: Partial<WalletDefaults>): Promise<BrowserWallet> {
  const client = new WalletClient('auto', 'simple')
  const { publicKey } = await client.getPublicKey({ identityKey: true })
  const wallet = new _BrowserWallet(client, publicKey, defaults)

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

export { BrowserWallet as Wallet }
export { Overlay } from './modules/overlay'
export { Certifier } from './modules/certification'
export { WalletCore } from './core/WalletCore'
export { DID } from './modules/did'
export {
  CredentialSchema,
  CredentialIssuer,
  MemoryRevocationStore,
  toVerifiableCredential,
  toVerifiablePresentation
} from './modules/credentials'
