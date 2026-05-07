import { Transaction, LockingScript, Script } from '@bsv/sdk'

/** Controls which outputs are covered by the signature. */
export type SignOutputs = 'all' | 'none' | 'single'
import { WalletDerivationParams } from '../../types/wallet'
import { Inscription, MAP } from '../../script-templates/ordinal'
import { OrdLockLockParams } from '../../script-templates/types'

// ============================================================================
// OUTPUT PARAMETER TYPES
// ============================================================================

/**
 * Parameters for adding a P2PKH output with a public key
 *
 * @property publicKey - Public key as hex string to lock the output to
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
export interface AddP2PKHOutputWithPublicKey {
  /** Public key as hex string to lock the output to */
  publicKey: string
  /** Amount in satoshis for this output */
  satoshis: number
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Parameters for adding a P2PKH output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
export interface AddP2PKHOutputWithWallet {
  /** Wallet derivation parameters (protocolID, keyID, counterparty) */
  walletParams: WalletDerivationParams
  /** Amount in satoshis for this output */
  satoshis: number
  /** Optional description for tracking purposes */
  description?: string
}

export interface AddP2PKHOutputWithAddress {
  address: string
  satoshis: number
  description?: string
}

/**
 * Parameters for adding a P2PKH output with BRC-29 auto-derivation
 *
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
export interface AddP2PKHOutputWithAutoDerivation {
  /** Amount in satoshis for this output */
  satoshis: number
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Union type for all P2PKH output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 */
export type AddP2PKHOutputParams =
    | AddP2PKHOutputWithPublicKey
    | AddP2PKHOutputWithAddress
    | AddP2PKHOutputWithWallet
    | AddP2PKHOutputWithAutoDerivation

/**
 * Parameters for adding a change output with a public key
 *
 * @property publicKey - Public key as hex string to send change to
 * @property description - Optional description for tracking purposes
 */
export interface AddChangeOutputWithPublicKey {
  /** Public key as hex string to send change to */
  publicKey: string
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Parameters for adding a change output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property description - Optional description for tracking purposes
 */
export interface AddChangeOutputWithWallet {
  /** Wallet derivation parameters (protocolID, keyID, counterparty) */
  walletParams: WalletDerivationParams
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Parameters for adding a change output with BRC-29 auto-derivation
 *
 * @property description - Optional description for tracking purposes
 */
export interface AddChangeOutputWithAutoDerivation {
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Union type for all change output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 * Amount is calculated automatically from remaining input satoshis.
 */
export type AddChangeOutputParams =
    | AddChangeOutputWithPublicKey
    | AddChangeOutputWithWallet
    | AddChangeOutputWithAutoDerivation

/**
 * Parameters for adding an ordinal P2PKH output with a public key
 *
 * @property publicKey - Public key as hex string to lock the output to
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
export interface AddOrdinalP2PKHOutputWithPublicKey {
  /** Public key as hex string to lock the output to */
  publicKey: string
  /** Amount in satoshis for this output (typically 1 for ordinals) */
  satoshis: number
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
  /** Optional description for tracking purposes */
  description?: string
}

export interface AddOrdinalP2PKHOutputWithAddress {
  address: string
  satoshis: number
  inscription?: Inscription
  metadata?: MAP
  description?: string
}

/**
 * Parameters for adding an ordinal P2PKH output with wallet derivation
 *
 * @property walletParams - Wallet derivation parameters (protocolID, keyID, counterparty)
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
export interface AddOrdinalP2PKHOutputWithWallet {
  /** Wallet derivation parameters (protocolID, keyID, counterparty) */
  walletParams: WalletDerivationParams
  /** Amount in satoshis for this output (typically 1 for ordinals) */
  satoshis: number
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Parameters for adding an ordinal P2PKH output with BRC-29 auto-derivation
 *
 * @property satoshis - Amount in satoshis for this output (typically 1 for ordinals)
 * @property inscription - Optional inscription data (dataB64, contentType)
 * @property metadata - Optional MAP metadata (app, type, and custom properties)
 * @property description - Optional description for tracking purposes
 */
export interface AddOrdinalP2PKHOutputWithAutoDerivation {
  /** Amount in satoshis for this output (typically 1 for ordinals) */
  satoshis: number
  /** Optional inscription data with base64 file data and content type */
  inscription?: Inscription
  /** Optional MAP metadata with app, type, and custom properties */
  metadata?: MAP
  /** Optional description for tracking purposes */
  description?: string
}

/**
 * Union type for all ordinal P2PKH output parameter variations.
 * Use one of: publicKey, walletParams, or auto-derivation (empty params).
 * Optionally include inscription and/or metadata for 1Sat Ordinals.
 */
export type AddOrdinalP2PKHOutputParams =
    | AddOrdinalP2PKHOutputWithPublicKey
    | AddOrdinalP2PKHOutputWithAddress
    | AddOrdinalP2PKHOutputWithWallet
    | AddOrdinalP2PKHOutputWithAutoDerivation

/**
 * Parameters for adding an OrdLock output.
 *
 * Note: `satoshis` is the satoshis locked in the OrdLock output itself (typically 1).
 * `price` is the amount the contract expects to be paid to the seller when purchased.
 */
export interface AddOrdLockOutputParams extends OrdLockLockParams {
  satoshis: number
  description?: string
}

/**
 * Parameters for adding a custom output with a specific locking script
 *
 * @property lockingScript - Custom locking script for this output
 * @property satoshis - Amount in satoshis for this output
 * @property description - Optional description for tracking purposes
 */
export interface AddCustomOutputParams {
  /** Custom locking script for this output */
  lockingScript: LockingScript
  /** Amount in satoshis for this output */
  satoshis: number
  /** Optional description for tracking purposes */
  description?: string
}

// ============================================================================
// INPUT PARAMETER TYPES
// ============================================================================

/**
 * Parameters for adding a P2PKH input to unlock a standard P2PKH output
 *
 * @property sourceTransaction - The transaction containing the output to spend
 * @property sourceOutputIndex - Index of the output to spend in the source transaction
 * @property walletParams - Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation.
 * @property description - Optional description for tracking purposes
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
export interface AddP2PKHInputParams {
  /** The transaction containing the output to spend */
  sourceTransaction: Transaction
  /** Index of the output to spend in the source transaction */
  sourceOutputIndex: number
  /** Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation. */
  walletParams?: WalletDerivationParams
  /** Optional description for tracking purposes */
  description?: string
  /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
  signOutputs?: SignOutputs
  /** Allow other inputs to be added later (default: false) */
  anyoneCanPay?: boolean
  /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
  sourceSatoshis?: number
  /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
  lockingScript?: Script
}

/**
 * Parameters for adding an OrdLock input.
 *
 * Use `kind: 'cancel'` to unlock via wallet signature.
 * Use `kind: 'purchase'` to unlock via outputs-blob + preimage.
 */
export interface AddOrdLockInputParams {
  sourceTransaction: Transaction
  sourceOutputIndex: number
  description?: string
  kind?: 'cancel' | 'purchase'
  walletParams?: WalletDerivationParams
  signOutputs?: SignOutputs
  anyoneCanPay?: boolean
  sourceSatoshis?: number
  lockingScript?: Script
}

/**
 * Parameters for adding an ordinal P2PKH input to unlock a 1Sat Ordinal output
 *
 * @property sourceTransaction - The transaction containing the ordinal output to spend
 * @property sourceOutputIndex - Index of the ordinal output to spend in the source transaction
 * @property walletParams - Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation.
 * @property description - Optional description for tracking purposes
 * @property signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
 * @property anyoneCanPay - Allow other inputs to be added later (default: false)
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
export interface AddOrdinalP2PKHInputParams {
  /** The transaction containing the ordinal output to spend */
  sourceTransaction: Transaction
  /** Index of the ordinal output to spend in the source transaction */
  sourceOutputIndex: number
  /** Optional wallet derivation parameters (protocolID, keyID, counterparty). If omitted, uses default P2PKH derivation. */
  walletParams?: WalletDerivationParams
  /** Optional description for tracking purposes */
  description?: string
  /** Signature scope: 'all', 'none', or 'single' (default: 'all') */
  signOutputs?: SignOutputs
  /** Allow other inputs to be added later (default: false) */
  anyoneCanPay?: boolean
  /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
  sourceSatoshis?: number
  /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
  lockingScript?: Script
}

/**
 * Parameters for adding a custom input with a specific unlocking script template
 *
 * @property unlockingScriptTemplate - Custom unlocking script template (must implement ScriptTemplate interface)
 * @property sourceTransaction - The transaction containing the output to spend
 * @property sourceOutputIndex - Index of the output to spend in the source transaction
 * @property description - Optional description for tracking purposes
 * @property sourceSatoshis - Optional amount in satoshis being unlocked (otherwise requires sourceTransaction)
 * @property lockingScript - Optional locking script being unlocked (otherwise requires sourceTransaction)
 */
export interface AddCustomInputParams {
  /** Custom unlocking script template (must implement ScriptTemplate interface) */
  unlockingScriptTemplate: any
  /** The transaction containing the output to spend */
  sourceTransaction: Transaction
  /** Index of the output to spend in the source transaction */
  sourceOutputIndex: number
  /** Optional description for tracking purposes */
  description?: string
  /** Optional amount in satoshis being unlocked (otherwise requires sourceTransaction) */
  sourceSatoshis?: number
  /** Optional locking script being unlocked (otherwise requires sourceTransaction) */
  lockingScript?: Script
}
