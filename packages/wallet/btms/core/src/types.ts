/**
 * BTMS Core Type Definitions
 * 
 * Type definitions for the Basic Token Management System.
 * These types align with the BTMSTopicManager protocol.
 */

import type {
  WalletInterface,
  AtomicBEEF,
  SatoshiValue,
  PubKeyHex,
  TXIDHexString,
  HexString,
  CommsLayer,
} from '@bsv/sdk'

// ---------------------------------------------------------------------------
// Protocol Types (aligned with BTMSTopicManager)
// ---------------------------------------------------------------------------

/**
 * BTMS Token Protocol Field Schema
 * 
 * BTMS tokens use 2-4 PushDrop fields:
 * - Field 0: assetId (or "ISSUE" for new token issuance)
 * - Field 1: amount (as UTF-8 string of a positive integer)
 * - Field 2: metadata (optional JSON string)
 * - Field 3: optional PushDrop signature (present when script-level signing is enabled)
 * 
 * For ISSUE tokens, the canonical assetId becomes `{txid}.{outputIndex}`
 * after the transaction is mined.
 */
export interface BTMSTokenFields {
  /** 
   * For issuance: "ISSUE" literal
   * For transfers: the canonical assetId (e.g., "abc123.0")
   */
  assetId: string
  /** Token amount (positive integer) */
  amount: number
  /** Optional JSON metadata string */
  metadata?: string
}

/**
 * Decoded BTMS token from a locking script
 */
export interface DecodedBTMSToken {
  /** Whether the token is valid according to BTMS protocol */
  valid: true
  /** The asset identifier (or "ISSUE" for issuance outputs) */
  assetId: string
  /** Token amount */
  amount: number
  /** Optional metadata JSON string */
  metadata?: string
  /** The locking public key from PushDrop */
  lockingPublicKey: string
}

/**
 * Invalid token decode result
 */
export interface InvalidBTMSToken {
  valid: false
  error?: string
}

/**
 * Result of decoding a BTMS token
 */
export type BTMSTokenDecodeResult = DecodedBTMSToken | InvalidBTMSToken

// ---------------------------------------------------------------------------
// Asset Types
// ---------------------------------------------------------------------------

/**
 * Represents a BTMS token asset
 */
export interface BTMSAsset {
  /** Canonical asset ID (txid.outputIndex format) */
  assetId: string
  /** Human-readable name from metadata */
  name?: string
  /** Current balance owned by this wallet */
  balance: number
  /** Asset metadata */
  metadata?: BTMSAssetMetadata
  /** Whether there are pending incoming tokens */
  hasPendingIncoming?: boolean
}

/**
 * Transaction history entry
 */
export interface BTMSTransaction {
  /** Transaction ID */
  txid: TXIDHexString
  /** Transaction type */
  type: 'issue' | 'send' | 'receive' | 'burn'
  /** Transaction direction from user's perspective */
  direction: 'incoming' | 'outgoing'
  /** Token amount involved */
  amount: number
  /** Asset ID */
  assetId: string
  /** Counterparty public key (if applicable) */
  counterparty?: PubKeyHex
  /** Transaction timestamp (if available) */
  timestamp?: number
  /** Transaction description */
  description?: string
  /** Transaction status */
  status: 'completed' | 'pending' | 'failed'
}

/**
 * Result of getTransactions query
 */
export interface GetTransactionsResult {
  /** List of transactions */
  transactions: BTMSTransaction[]
  /** Total number of transactions (for pagination) */
  total: number
}

/**
 * Asset metadata structure
 */
export interface BTMSAssetMetadata {
  /** Asset name */
  name?: string
  /** Asset description */
  description?: string
  /** Asset icon URL */
  iconURL?: string
  /** Additional custom fields */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// UTXO Selection Types
// ---------------------------------------------------------------------------

/**
 * UTXO selection strategy for spending tokens.
 * Different strategies optimize for different goals.
 */
export type SelectionStrategy =
  | 'largest-first'   // Greedy: use largest UTXOs first (minimizes UTXO count)
  | 'smallest-first'  // Use smallest UTXOs first (preserves large UTXOs for big payments)
  | 'exact-match'     // Try to find exact match first, then fall back to largest-first
  | 'random'          // Random selection (privacy-preserving)

/**
 * Options for UTXO selection
 */
export interface SelectionOptions {
  /** Selection strategy to use (default: 'largest-first') */
  strategy?: SelectionStrategy
  /** Fallback strategy when exact-match fails (default: 'largest-first') */
  fallbackStrategy?: Exclude<SelectionStrategy, 'exact-match'>
  /** Maximum number of UTXOs to select (default: unlimited) */
  maxInputs?: number
  /** Minimum UTXO amount to consider (default: 0) */
  minUtxoAmount?: number
}

/**
 * Result of UTXO selection
 */
export interface SelectionResult<T> {
  /** Selected UTXOs */
  selected: T[]
  /** Total input amount from selected UTXOs */
  totalInput: number
  /** UTXOs that were excluded (not found on overlay, etc.) */
  excluded: T[]
}

// ---------------------------------------------------------------------------
// Change Strategy Types
// ---------------------------------------------------------------------------

/**
 * Represents a single change output to be created
 */
export interface ChangeOutput {
  /** Token amount for this change output */
  amount: number
}

/**
 * Context provided to change strategies for computing change outputs
 */
export interface ChangeContext {
  /** Total change amount to distribute */
  changeAmount: number
  /** Original payment amount being sent */
  paymentAmount: number
  /** Total input amount from selected UTXOs */
  totalInput: number
  /** Asset ID being transferred */
  assetId: string
}

/**
 * Interface for custom change generation strategies.
 * Implementations determine how change is split across outputs.
 */
export interface ChangeStrategy {
  /**
   * Compute the change outputs for a transaction.
   * The sum of all returned output amounts must equal changeAmount.
   * 
   * @param context - Context about the transaction
   * @returns Array of change outputs to create
   */
  computeChange(context: ChangeContext): ChangeOutput[]
}

/**
 * Built-in change strategy types
 */
export type ChangeStrategyType =
  | 'single'       // Single change output (default)
  | 'split-equal'  // Split into equal amounts
  | 'split-random' // Split into random amounts (Benford distribution)

/**
 * Options for built-in change strategies
 */
export interface ChangeStrategyOptions {
  /** Strategy type or custom strategy implementation */
  strategy?: ChangeStrategyType | ChangeStrategy
  /** Number of outputs for split strategies (default: 2) */
  splitCount?: number
  /** Minimum amount per output for split strategies (default: 1) */
  minOutputAmount?: number
}

// ---------------------------------------------------------------------------
// Transfer Strategy Types (Multi-Transaction Privacy)
// ---------------------------------------------------------------------------

/**
 * Represents a single transaction in a multi-transaction transfer
 */
export interface TransferTransaction {
  /** Transaction ID */
  txid: TXIDHexString
  /** Output index for the recipient's token */
  outputIndex: number
  /** Token amount in this transaction */
  amount: number
  /** Locking script for the recipient's output */
  lockingScript: HexString
  /** Derivation suffix for this specific output */
  derivationSuffix: string
}

/**
 * Options for splitting transfers across multiple transactions
 */
export interface TransferSplitOptions {
  /** Number of transactions to split across (default: 1 = no split) */
  transactionCount?: number
  /** How to distribute amounts across transactions */
  distribution?: 'equal' | 'random'
  /** Minimum amount per transaction (default: 1) */
  minAmountPerTx?: number
}

/**
 * Token transfer data for recipient (supports multi-transaction transfers)
 */
export interface MultiTransactionTransfer {
  /** Shared derivation prefix for all outputs in this transfer */
  derivationPrefix: string
  /** Asset being transferred */
  assetId: string
  /** Total amount across all transactions */
  totalAmount: number
  /** Asset metadata */
  metadata?: string
  /** Individual transactions in this transfer */
  transactions: TransferTransaction[]
  /** Merged BEEF containing all transactions */
  beef: AtomicBEEF
}

// ---------------------------------------------------------------------------
// Token Output Types
// ---------------------------------------------------------------------------

/**
 * A BTMS token UTXO from the wallet
 */
export interface BTMSTokenOutput {
  /** Outpoint in "txid.outputIndex" format */
  outpoint: string
  /** Transaction ID */
  txid: TXIDHexString
  /** Output index */
  outputIndex: number
  /** Satoshi value (typically 1 for BTMS tokens) */
  satoshis: SatoshiValue
  /** Locking script hex */
  lockingScript: HexString
  /** Custom instructions containing derivation keys */
  customInstructions?: string
  /** Decoded token data */
  token: DecodedBTMSToken
  /** Whether this output is spendable */
  spendable: boolean
  /** Full transaction BEEF (when available) */
  beef?: AtomicBEEF
}

/**
 * Token data sent to a recipient
 */
export interface TokenForRecipient {
  /** Transaction ID containing the token */
  txid: TXIDHexString
  /** Output index of the token */
  outputIndex: number
  /** Locking script hex */
  lockingScript: HexString
  /** Token amount */
  amount: number
  /** Satoshi value */
  satoshis: SatoshiValue
  /** Full BEEF for SPV verification */
  beef: AtomicBEEF
  /** Custom instructions containing derivation keys */
  customInstructions: string
  /** Asset ID */
  assetId: string
  /** Metadata JSON */
  metadata?: string
}

/**
 * Incoming token from another user.
 * Extends TokenForRecipient with messaging metadata.
 */
export interface IncomingToken extends TokenForRecipient {
  /** Sender's identity key (added by messaging layer) */
  sender: PubKeyHex
  /** Message ID for acknowledgment (added by messaging layer) */
  messageId: string
}

// ---------------------------------------------------------------------------
// Operation Result Types
// ---------------------------------------------------------------------------

/**
 * Result of a token issuance operation
 */
export interface IssueResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Transaction ID of the issuance */
  txid: TXIDHexString
  /** Canonical asset ID (txid.0 for single output) */
  assetId: string
  /** Output index of the token */
  outputIndex: number
  /** Amount issued */
  amount: number
  /** Error message if failed */
  error?: string
}

/**
 * Result of a token send operation
 */
export interface SendResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Transaction ID */
  txid: TXIDHexString
  /** Token data for recipient */
  tokenForRecipient: TokenForRecipient
  /** Change amount returned to sender (if any) */
  changeAmount?: number
  /** Error message if failed */
  error?: string
}

/**
 * Result of accepting an incoming payment
 */
export interface AcceptResult {
  /** Whether the operation succeeded */
  success: boolean
  /** The accepted asset ID */
  assetId: string
  /** Amount accepted */
  amount: number
  /** Error message if failed */
  error?: string
}

/**
 * Result of refunding an incoming payment
 */
export interface RefundResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Transaction ID for the refund */
  txid: TXIDHexString
  /** The refunded asset ID */
  assetId: string
  /** Amount refunded */
  amount: number
  /** Error message if failed */
  error?: string
}

/**
 * Result of a token burn operation
 */
export interface BurnResult {
  /** Whether the operation succeeded */
  success: boolean
  /** Transaction ID */
  txid: TXIDHexString
  /** Asset ID that was burned */
  assetId: string
  /** Amount of tokens burned (destroyed) */
  amountBurned: number
  /** Error message if failed */
  error?: string
}

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * BTMS configuration options
 */
export interface BTMSConfig {
  /** Wallet interface for signing transactions (default: new WalletClient()) */
  wallet?: WalletInterface
  /** Network preset for overlay services (default: 'mainnet') */
  networkPreset?: 'local' | 'mainnet' | 'testnet'
  /** Optional communications layer for token messaging (e.g., MessageBoxClient) */
  comms?: CommsLayer
}

// ---------------------------------------------------------------------------
// Ownership Proof Types
// ---------------------------------------------------------------------------

/**
 * Key linkage revelation for a specific token
 */
export interface TokenKeyLinkage {
  /** The prover's identity public key */
  prover: PubKeyHex
  /** The verifier's identity public key */
  verifier: PubKeyHex
  /** The counterparty (for BTMS, typically 'self' resolved to prover's key) */
  counterparty: PubKeyHex
  /** Encrypted linkage data */
  encryptedLinkage: number[]
  /** Encrypted linkage proof */
  encryptedLinkageProof: number[]
  /** Proof type byte */
  proofType: number
}

/**
 * A proven token with its output data and key linkage
 */
export interface ProvenToken {
  /** The token output being proven */
  output: {
    txid: TXIDHexString
    outputIndex: number
    lockingScript: HexString
    satoshis: SatoshiValue
  }
  /** Key derivation identifier used to create the linkage proof */
  keyID: string
  /** Key linkage revelation for this token */
  linkage: TokenKeyLinkage
}

/**
 * Ownership proof for a set of tokens
 */
export interface OwnershipProof {
  /** The prover's identity public key */
  prover: PubKeyHex
  /** The verifier's identity public key */
  verifier: PubKeyHex
  /** The proven tokens with their linkages */
  tokens: ProvenToken[]
  /** Total amount being proven */
  amount: number
  /** Asset ID being proven */
  assetId: string
}

/**
 * Result of proving ownership
 */
export interface ProveOwnershipResult {
  /** Whether the operation succeeded */
  success: boolean
  /** The ownership proof (if successful) */
  proof?: OwnershipProof
  /** Error message if failed */
  error?: string
}

/**
 * Result of verifying ownership
 */
export interface VerifyOwnershipResult {
  /** Whether the proof is valid */
  valid: boolean
  /** The verified amount */
  amount?: number
  /** The verified asset ID */
  assetId?: string
  /** The prover's identity key */
  prover?: PubKeyHex
  /** Error message if verification failed */
  error?: string
}

// ---------------------------------------------------------------------------
// Marketplace Types (for future extensibility)
// ---------------------------------------------------------------------------

/**
 * Marketplace listing for atomic swaps (future use)
 */
export interface MarketplaceListing {
  /** Listing ID */
  listingId: string
  /** Asset being sold */
  assetId: string
  /** Amount for sale */
  amount: number
  /** Price in satoshis */
  priceSatoshis: number
  /** Seller's identity key */
  seller: PubKeyHex
  /** Listing expiry timestamp */
  expiresAt?: number
}

/**
 * Marketplace offer for atomic swaps (future use)
 */
export interface MarketplaceOffer {
  /** Offer ID */
  offerId: string
  /** Listing being offered on */
  listingId: string
  /** Offered price in satoshis */
  offerSatoshis: number
  /** Buyer's identity key */
  buyer: PubKeyHex
  /** Offer expiry timestamp */
  expiresAt?: number
}
