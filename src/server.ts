import {
  PrivateKey,
  KeyDeriver,
  Utils,
  Random,
  WalletInterface
} from '@bsv/sdk'
import {
  Wallet as ToolboxWallet,
  WalletStorageManager,
  WalletSigner,
  Services,
  StorageClient,
  Chain
} from '@bsv/wallet-toolbox'
import { WalletCore } from './core/WalletCore'
import {
  WalletDefaults,
  ServerWalletConfig,
  PaymentRequest,
  IncomingPayment
} from './core/types'
import { createTokenMethods } from './modules/tokens'
import { createInscriptionMethods } from './modules/inscriptions'
import { createMessageBoxMethods } from './modules/messagebox'
import { createCertificationMethods } from './modules/certification'
import { createOverlayMethods } from './modules/overlay'
import { createDIDMethods } from './modules/did'
import { createCredentialMethods } from './modules/credentials'

// Re-export everything from the browser entry
export * from './browser'
export type { BrowserWallet } from './browser'

// Re-export all types (including server-only types)
export type {
  Network,
  WalletDefaults,
  TransactionResult,
  OutputInfo,
  ReinternalizeResult,
  WalletStatus,
  WalletInfo,
  PaymentOptions,
  SendOutputSpec,
  SendOutputDetail,
  SendOptions,
  SendResult,
  DerivationInfo,
  PaymentDerivation,
  TokenOptions,
  TokenResult,
  TokenDetail,
  SendTokenOptions,
  RedeemTokenOptions,
  InscriptionType,
  InscriptionOptions,
  InscriptionResult,
  MessageBoxConfig,
  CertifierConfig,
  CertificateData,
  OverlayConfig,
  OverlayInfo,
  OverlayBroadcastResult,
  OverlayOutput,
  ServerWalletConfig,
  PaymentRequest,
  IncomingPayment,
  DIDDocument,
  DIDVerificationMethod,
  DIDParseResult,
  CredentialFieldType,
  CredentialFieldSchema,
  CredentialSchemaConfig,
  VerifiableCredential,
  VerifiablePresentation,
  VerificationResult,
  CredentialIssuerConfig,
  RevocationRecord,
  RevocationStore
} from './core/types'

// Re-export errors
export {
  SimpleError,
  WalletError,
  TransactionError,
  MessageBoxError,
  CertificationError,
  DIDError,
  CredentialError
} from './core/errors'

// Server-specific exports
export { FileRevocationStore } from './modules/file-revocation-store'

// ============================================================================
// Utility: generate a random private key hex without exposing @bsv/sdk
// ============================================================================

export function generatePrivateKey(): string {
  return PrivateKey.fromRandom().toHex()
}

// ============================================================================
// Re-export server handler utilities
// ============================================================================

export {
  // Handler types & utilities
  HandlerRequest,
  HandlerResponse,
  RouteHandler,
  getSearchParams,
  jsonResponse,
  toNextHandlers,
  // File persistence
  JsonFileStore,
  // Identity Registry
  IdentityRegistry,
  RegistryResult,
  createIdentityRegistryHandler,
  // DID Resolver
  DIDResolverService,
  createDIDResolverHandler,
  // Server Wallet Manager
  ServerWalletManager,
  createServerWalletHandler,
  // Credential Issuer Handler
  createCredentialIssuerHandler
} from './server/index'

// ============================================================================
// _ServerWallet extends WalletCore with wallet-toolbox
// ============================================================================

class _ServerWallet extends WalletCore {
  private client: ToolboxWallet

  constructor(client: ToolboxWallet, identityKey: string, defaults?: Partial<WalletDefaults>) {
    super(identityKey, defaults)
    this.client = client
  }

  getClient(): WalletInterface {
    return this.client as unknown as WalletInterface
  }

  createPaymentRequest(options: { satoshis: number; memo?: string }): PaymentRequest {
    const derivationPrefix = Utils.toBase64(Utils.toArray('payment', 'utf8'))
    const derivationSuffix = Utils.toBase64(Random(8))
    return {
      serverIdentityKey: this.identityKey,
      derivationPrefix,
      derivationSuffix,
      satoshis: options.satoshis,
      memo: options.memo
    }
  }

  async receivePayment(payment: IncomingPayment): Promise<void> {
    const tx = payment.tx instanceof Uint8Array
      ? Array.from(payment.tx)
      : payment.tx

    await this.client.internalizeAction({
      tx,
      outputs: [{
        outputIndex: payment.outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          senderIdentityKey: payment.senderIdentityKey,
          derivationPrefix: payment.derivationPrefix,
          derivationSuffix: payment.derivationSuffix
        }
      }],
      description: payment.description || `Payment from ${payment.senderIdentityKey.substring(0, 20)}...`,
      labels: ['server_funding']
    } as any)
  }
}

// ============================================================================
// Composed ServerWallet type
// ============================================================================

export type ServerWallet = _ServerWallet
  & ReturnType<typeof createTokenMethods>
  & ReturnType<typeof createInscriptionMethods>
  & ReturnType<typeof createMessageBoxMethods>
  & ReturnType<typeof createCertificationMethods>
  & ReturnType<typeof createOverlayMethods>
  & ReturnType<typeof createDIDMethods>
  & ReturnType<typeof createCredentialMethods>

// ============================================================================
// Static factory on the ServerWallet namespace
// ============================================================================

export namespace ServerWallet {
  export async function create(config: ServerWalletConfig): Promise<ServerWallet> {
    const privateKey = PrivateKey.fromHex(config.privateKey)
    const keyDeriver = new KeyDeriver(privateKey)
    const identityKey = keyDeriver.identityKey
    const network = (config.network || 'main') as Chain

    const storageManager = new WalletStorageManager(identityKey)
    const signer = new WalletSigner(network, keyDeriver, storageManager)
    const services = new Services(network)
    const toolboxWallet = new ToolboxWallet(signer, services)

    const storageUrl = config.storageUrl || 'https://storage.babbage.systems'
    const storageClient = new StorageClient(toolboxWallet, storageUrl)
    await storageClient.makeAvailable()
    await storageManager.addWalletStorageProvider(storageClient)

    const wallet = new _ServerWallet(toolboxWallet, identityKey, { network: config.network || 'main' })

    Object.assign(wallet, createTokenMethods(wallet))
    Object.assign(wallet, createInscriptionMethods(wallet))
    Object.assign(wallet, createMessageBoxMethods(wallet))
    Object.assign(wallet, createCertificationMethods(wallet))
    Object.assign(wallet, createOverlayMethods(wallet))
    Object.assign(wallet, createDIDMethods(wallet))
    Object.assign(wallet, createCredentialMethods(wallet))

    return wallet as ServerWallet
  }
}
