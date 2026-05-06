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
import { WalletCore } from '../core/WalletCore'
import {
  WalletDefaults,
  ServerWalletConfig,
  IncomingPayment
} from '../core/types'
import { createTokenMethods } from '../modules/tokens'
import { createInscriptionMethods } from '../modules/inscriptions'
import { createMessageBoxMethods } from '../modules/messagebox'
import { createCertificationMethods } from '../modules/certification'
import { createOverlayMethods } from '../modules/overlay'
import { createDIDMethods } from '../modules/did'
import { createCredentialMethods } from '../modules/credentials'

// ============================================================================
// _ServerWallet extends WalletCore with wallet-toolbox
// ============================================================================

class _ServerWallet extends WalletCore {
  private readonly client: ToolboxWallet

  constructor (client: ToolboxWallet, identityKey: string, defaults?: Partial<WalletDefaults>) {
    super(identityKey, defaults)
    this.client = client
  }

  getClient (): WalletInterface {
    return this.client as unknown as WalletInterface
  }

  /**
   * @deprecated Use `receiveDirectPayment()` instead. Kept for backward compatibility.
   * Internalizes a payment using the `wallet payment` protocol with `server_funding` label.
   */
  async receivePayment (payment: IncomingPayment): Promise<void> {
    const tx = payment.tx instanceof Uint8Array
      ? Array.from(payment.tx)
      : payment.tx

    const description = (payment.description != null && payment.description !== '')
      ? payment.description
      : `Payment from ${payment.senderIdentityKey.substring(0, 20)}...`

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
      description,
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
  export async function create (config: ServerWalletConfig): Promise<ServerWallet> {
    const privateKey = PrivateKey.fromHex(config.privateKey)
    const keyDeriver = new KeyDeriver(privateKey)
    const identityKey = keyDeriver.identityKey
    const network: Chain = (config.network ?? 'main') as Chain

    const storageManager = new WalletStorageManager(identityKey)
    const signer = new WalletSigner(network, keyDeriver, storageManager)
    const services = new Services(network)
    const toolboxWallet = new ToolboxWallet(signer, services)

    const storageUrl = config.storageUrl ?? 'https://storage.babbage.systems'
    const storageClient = new StorageClient(toolboxWallet, storageUrl)
    await storageClient.makeAvailable()
    await storageManager.addWalletStorageProvider(storageClient)

    const wallet = new _ServerWallet(toolboxWallet, identityKey, { network: config.network ?? 'main' })

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
