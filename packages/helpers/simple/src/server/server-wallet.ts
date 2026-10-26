/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-redeclare, @typescript-eslint/indent */
/**
 * ServerWallet — server-side wallet implementation backed by `@bsv/wallet-toolbox`.
 *
 * Lives as a sibling file inside `server/` so that other server-side modules
 * (e.g. `server-wallet-manager.ts`) can dynamically import it directly
 * without going through the parent `server.ts` barrel — which would create
 * a circular dependency:
 *   server.ts -> server/index.ts -> server/<sibling>.ts -> server.ts
 *
 * The lint disables above mirror the pre-existing exceptions for the
 * ServerWallet declaration that previously lived in `server.ts`. They preserve
 * the public API (a `type ServerWallet` alongside a same-named namespace
 * exposing `ServerWallet.create`).
 */

import {
  PrivateKey,
  KeyDeriver,
  WalletInterface,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import {
  Wallet as ToolboxWallet,
  WalletStorageManager,
  WalletSigner,
  Services,
  StorageClient,
  Chain
} from '@bsv/wallet-toolbox'
import { WalletCore } from '../core/WalletCore'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { canonicalIdentityKey } from '../core/certificate-validation'
import { snapshotDenseByteArray } from '../core/byte-validation'
import {
  validateBase64String,
  validateInteger,
  validateStringLength
} from '@bsv/sdk/wallet/validationHelpers'
import { WalletDefaults, ServerWalletConfig, IncomingPayment } from '../core/types'
import { createTokenMethods } from '../modules/tokens'
import { createInscriptionMethods } from '../modules/inscriptions'
import { createMessageBoxMethods } from '../modules/messagebox'
import { createCertificationMethods } from '../modules/certification'
import { createOverlayMethods } from '../modules/overlay'
import { createDIDMethods } from '../modules/did'
import { createCredentialMethods } from '../modules/credentials'

// ============================================================================
// ServerWalletCore extends WalletCore with wallet-toolbox
// ============================================================================

class ServerWalletCore extends WalletCore {
  private readonly client: ToolboxWallet

  constructor(client: ToolboxWallet, identityKey: string, defaults?: Partial<WalletDefaults>) {
    super(identityKey, defaults)
    this.client = client
  }

  getClient(): WalletInterface {
    return this.client as unknown as WalletInterface
  }

  /**
   * @deprecated Use `receiveDirectPayment()` instead. Kept for backward compatibility.
   * Internalizes a payment using the `wallet payment` protocol with `server_funding` label.
   */
  async receivePayment(payment: IncomingPayment): Promise<void> {
    const record = snapshotPlainDataRecord(payment)
    if (record == null) throw new TypeError('Incoming payment is invalid')
    const tx = snapshotDenseByteArray(record.tx, 'Incoming payment transaction', 64 * 1024 * 1024)
    if (tx.length === 0) {
      throw new TypeError('Incoming payment transaction is invalid')
    }

    const senderIdentityKey = canonicalIdentityKey(
      record.senderIdentityKey,
      'incoming payment sender identity key'
    )
    const derivationPrefix = validateBase64String(
      record.derivationPrefix as string,
      'derivationPrefix',
      1,
      256
    )
    const derivationSuffix = validateBase64String(
      record.derivationSuffix as string,
      'derivationSuffix',
      1,
      256
    )
    const outputIndex = validateInteger(
      record.outputIndex as number | undefined,
      'outputIndex',
      undefined,
      0,
      0xffffffff
    )

    const description =
      typeof record.description === 'string' && record.description !== ''
        ? validateStringLength(record.description, 'description', 5, 2000)
        : `Payment from ${senderIdentityKey.substring(0, 20)}...`

    const internalizeArgs = {
      tx,
      outputs: [
        {
          outputIndex,
          protocol: 'wallet payment' as const,
          paymentRemittance: {
            senderIdentityKey,
            derivationPrefix,
            derivationSuffix
          }
        }
      ],
      description,
      labels: ['server_funding']
    }
    validateWalletArgs('internalizeAction', internalizeArgs)
    const bindingRequest = snapshotWalletResultRequest('internalizeAction', internalizeArgs)
    const internalizeResult = await this.client.internalizeAction(internalizeArgs)
    try {
      validateWalletResult('internalizeAction', internalizeResult, bindingRequest)
    } catch {
      throw new Error('Receiving wallet did not accept the payment')
    }
  }
}

// ============================================================================
// Composed ServerWallet type
// ============================================================================

export type ServerWallet = ServerWalletCore &
  ReturnType<typeof createTokenMethods> &
  ReturnType<typeof createInscriptionMethods> &
  ReturnType<typeof createMessageBoxMethods> &
  ReturnType<typeof createCertificationMethods> &
  ReturnType<typeof createOverlayMethods> &
  ReturnType<typeof createDIDMethods> &
  ReturnType<typeof createCredentialMethods>

// ============================================================================
// Static factory on the ServerWallet namespace
// ============================================================================

export namespace ServerWallet {
  export async function create(config: ServerWalletConfig): Promise<ServerWallet> {
    const ownedConfig = snapshotPlainDataRecord(config)
    if (ownedConfig == null || typeof ownedConfig.privateKey !== 'string') {
      throw new TypeError('Invalid server wallet configuration')
    }
    const privateKey = PrivateKey.fromHex(ownedConfig.privateKey)
    const keyDeriver = new KeyDeriver(privateKey)
    const identityKey = keyDeriver.identityKey
    const configuredNetwork = ownedConfig.network ?? 'main'
    if (configuredNetwork !== 'main' && configuredNetwork !== 'testnet') {
      throw new TypeError('Invalid server wallet network')
    }
    const network: Chain = configuredNetwork === 'testnet' ? 'test' : 'main'

    const storageManager = new WalletStorageManager(identityKey)
    const signer = new WalletSigner(network, keyDeriver, storageManager)
    const services = new Services(network)
    const toolboxWallet = new ToolboxWallet(signer, services)

    const storageUrl = ownedConfig.storageUrl ?? 'https://storage.babbage.systems'
    if (typeof storageUrl !== 'string') throw new TypeError('Invalid server wallet storage URL')
    const storageClient = new StorageClient(toolboxWallet, storageUrl)
    await storageClient.makeAvailable()
    await storageManager.addWalletStorageProvider(storageClient)

    const wallet = new ServerWalletCore(toolboxWallet, identityKey, {
      network: configuredNetwork
    })

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
