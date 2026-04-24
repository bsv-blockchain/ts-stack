/**
 * @bsv/btms - Basic Token Management System
 * 
 * A modular library for managing UTXO-based tokens on the BSV blockchain.
 * 
 * This library provides:
 * - Token issuance with customizable metadata
 * - Token transfers between users
 * - Token receiving and acceptance
 * - Balance and asset queries
 * 
 * The implementation aligns exactly with the BTMSTopicManager protocol,
 * using a 3-field PushDrop schema:
 * - Field 0: assetId (or "ISSUE" for new tokens)
 * - Field 1: amount (positive integer as string)
 * - Field 2: metadata (optional JSON)
 * 
 * @example
 * ```typescript
 * import { BTMS } from '@bsv/btms'
 * 
 * // Create a BTMS instance
 * const btms = new BTMS({ networkPreset: 'mainnet' })
 * 
 * // Issue new tokens
 * const result = await btms.issue(1000, { name: 'MyToken' })
 * console.log('Asset ID:', result.assetId)
 * 
 * // Send tokens
 * await btms.send(result.assetId, recipientPubKey, 100)
 * 
 * // Check balance
 * const balance = await btms.getBalance(result.assetId)
 * ```
 * 
 * @packageDocumentation
 */

// Main class
export { BTMS } from './BTMS.js'

// Advanced extension class
// export { BTMSAdvanced } from './BTMSAdvanced.js'

// Token encoding/decoding
export { BTMSToken } from './BTMSToken.js'

// Types
export type {
  // Protocol types
  BTMSTokenFields,
  DecodedBTMSToken,
  InvalidBTMSToken,
  BTMSTokenDecodeResult,

  // Asset types
  BTMSAsset,
  BTMSAssetMetadata,

  // Token output types
  BTMSTokenOutput,
  TokenForRecipient,
  IncomingToken,

  // UTXO selection types
  SelectionStrategy,
  SelectionOptions,
  SelectionResult,

  // Change strategy types
  ChangeOutput,
  ChangeContext,
  ChangeStrategy,
  ChangeStrategyType,
  ChangeStrategyOptions,

  // Multi-transaction transfer types
  TransferSplitOptions,
  TransferTransaction,
  MultiTransactionTransfer,

  // Operation result types
  IssueResult,
  SendResult,
  AcceptResult,
  RefundResult,
  BurnResult,

  // Configuration types
  BTMSConfig,

  // Marketplace types (future)
  MarketplaceListing,
  MarketplaceOffer,

  // Ownership proof types
  TokenKeyLinkage,
  ProvenToken,
  OwnershipProof,
  ProveOwnershipResult,
  VerifyOwnershipResult,

  // Transaction history types
  BTMSTransaction,
  GetTransactionsResult
} from './types.js'

// Constants
export {
  BTMS_TOPIC,
  BTMS_LOOKUP_SERVICE,
  BTMS_PROTOCOL_ID,
  BTMS_LABEL_PREFIX,
  BTMS_BASKET,
  DEFAULT_TOKEN_SATOSHIS,
  ISSUE_MARKER,
  MIN_TOKEN_AMOUNT,
  MAX_TOKEN_AMOUNT
} from './constants.js'

// Utilities
export { parseCustomInstructions } from './utils.js'
export type { ParsedCustomInstructions } from './utils.js'
