import { WalletProtocol, WalletCounterparty, Script } from '@bsv/sdk'
import { WalletDerivationParams } from '../../types/wallet'
import { Inscription, MAP } from '../ordinal'

/**
 * Parameters for P2PKH lock method with public key hash
 *
 * @property pubkeyhash - 20-byte public key hash array
 */
export interface P2PKHLockWithPubkeyhash {
  /** 20-byte public key hash array */
  pubkeyhash: number[]
}

/**
 * Parameters for P2PKH lock method with public key
 *
 * @property publicKey - Public key as hex string
 */
export interface P2PKHLockWithPublicKey {
  /** Public key as hex string */
  publicKey: string
}

export interface P2PKHLockWithAddress {
  address: string
}

/**
 * Parameters for P2PKH lock method with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 */
export interface P2PKHLockWithWallet {
  /** Wallet derivation parameters (protocolID, keyID, counterparty) */
  walletParams: WalletDerivationParams
}

/**
 * Union type for all P2PKH lock parameter variations.
 * Use one of: pubkeyhash, publicKey, or walletParams.
 */
export type P2PKHLockParams =
    | P2PKHLockWithPubkeyhash
    | P2PKHLockWithPublicKey
    | P2PKHLockWithAddress
    | P2PKHLockWithWallet

/**
 * Parameters for P2PKH unlock method
 *
 * @property protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
 * @property keyID - Specific key identifier within the protocol (default: '0')
 * @property counterparty - The counterparty for which the key is being used (default: 'self')
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked
 * @property lockingScript - Optional locking script being unlocked
 */
export interface P2PKHUnlockParams {
  /** Protocol identifier for key derivation (default: [2, "p2pkh"]) */
  protocolID?: WalletProtocol
  /** Specific key identifier within the protocol (default: '0') */
  keyID?: string
  /** The counterparty for which the key is being used (default: 'self') */
  counterparty?: WalletCounterparty
  /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
  signOutputs?: 'all' | 'none' | 'single'
  /** Allow other inputs to be added later (default: false) */
  anyoneCanPay?: boolean
  /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
  sourceSatoshis?: number
  /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
  lockingScript?: Script
}

/**
 * Parameters for OrdP2PKH lock method with public key hash
 *
 * @property pubkeyhash - 20-byte public key hash array
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
export interface OrdinalLockWithPubkeyhash {
  /** 20-byte public key hash array */
  pubkeyhash: number[]
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
}

/**
 * Parameters for OrdP2PKH lock method with public key
 *
 * @property publicKey - Public key as hex string
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
export interface OrdinalLockWithPublicKey {
  /** Public key as hex string */
  publicKey: string
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
}

export interface OrdinalLockWithAddress {
  address: string
  inscription?: Inscription
  metadata?: MAP
}

/**
 * Parameters for OrdP2PKH lock method with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 */
export interface OrdinalLockWithWallet {
  /** Wallet derivation parameters (protocolID, keyID, counterparty) */
  walletParams: WalletDerivationParams
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
}

/**
 * Union type for all OrdP2PKH lock parameter variations.
 * Use one of: pubkeyhash, publicKey, or walletParams.
 * Optionally include inscription and/or metadata for 1Sat Ordinals.
 */
export type OrdinalLockParams =
    | OrdinalLockWithPubkeyhash
    | OrdinalLockWithPublicKey
    | OrdinalLockWithAddress
    | OrdinalLockWithWallet

/**
 * Parameters for OrdP2PKH unlock method (same as {@link P2PKHUnlockParams})
 */
export type OrdinalUnlockParams = P2PKHUnlockParams

/**
 * Parameters for OrdLock lock method.
 *
 * This creates an OrdLock (order lock) locking script.
 */
export interface OrdLockLockParams {
  ordAddress: string
  payAddress: string
  price: number
  assetId: string
  itemData?: Record<string, any>
  metadata?: Record<string, any>
}

/**
 * Unlock params for cancelling an OrdLock.
 *
 * Uses a wallet signature (BRC-29 pattern) + pubkey + OP_1.
 */
export interface OrdLockCancelUnlockParams extends P2PKHUnlockParams {
  protocolID?: WalletProtocol
  keyID?: string
  counterparty?: WalletCounterparty
}

/**
 * Unlock params for purchasing/spending an OrdLock.
 *
 * This unlock path does not require a wallet because the contract expects
 * an outputs blob + preimage + OP_0.
 */
export interface OrdLockPurchaseUnlockParams {
  sourceSatoshis?: number
  lockingScript?: Script
}

export type OrdLockUnlockParams =
  | ({ kind?: 'cancel' } & OrdLockCancelUnlockParams)
  | ({ kind: 'purchase' } & OrdLockPurchaseUnlockParams)
