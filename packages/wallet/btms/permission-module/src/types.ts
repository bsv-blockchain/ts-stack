// ---------------------------------------------------------------------------
// BTMS Permission Module Constants and Types
// ---------------------------------------------------------------------------
// BRC-99: Baskets prefixed with "p " are permissioned and require wallet
// permission module support. The scheme ID is "btms".
//
// Token basket format: "p btms <assetId>"
// Example: "p btms abc123def456.0"
// ---------------------------------------------------------------------------

/** Permissioned basket prefix - aligns with btms-core */
export const P_BASKET_PREFIX = 'p btms'

/** Literal used in field[0] to indicate token issuance - aligns with btms-core */
export const ISSUE_MARKER = 'ISSUE'

/** Index positions for BTMS PushDrop token fields */
export const BTMS_FIELD = {
  ASSET_ID: 0,
  AMOUNT: 1,
  METADATA: 2
} as const

/**
 * Parsed information about a BTMS token from its locking script
 */
export interface ParsedTokenInfo {
  assetId: string
  amount: number
  metadata?: {
    name?: string
    description?: string
    iconURL?: string
    [key: string]: unknown
  }
}

/**
 * Comprehensive token spend information extracted from createAction args
 */
export interface TokenSpendInfo {
  /** Total amount being sent to recipient (not including change) */
  sendAmount: number
  /** Total amount being spent from inputs */
  totalInputAmount: number
  /** Change amount (totalInputAmount - sendAmount) */
  changeAmount: number
  /** Total amount sent in token outputs (derived from outputs) */
  outputSendAmount: number
  /** Total amount returned as change in token outputs (derived from outputs) */
  outputChangeAmount: number
  /** Whether any token outputs were parsed */
  hasTokenOutputs: boolean
  /** Source of totalInputAmount */
  inputAmountSource: 'beef' | 'descriptions' | 'derived' | 'none'
  /** Token name from metadata */
  tokenName: string
  /** Asset ID */
  assetId: string
  /** Recipient identity key (truncated) */
  recipient?: string
  /** Token icon URL if available */
  iconURL?: string
  /** Full action description */
  actionDescription: string
}

/**
 * Authorized transaction data captured from createAction response.
 * Used to verify createSignature calls are signing what was actually authorized.
 */
export interface AuthorizedTransaction {
  /** The reference from the signable transaction */
  reference: string
  /** Hash of all outputs (BIP-143 hashOutputs) */
  hashOutputs: string
  /** Set of authorized outpoints (txid.vout format) */
  authorizedOutpoints: Set<string>
  /** Timestamp when this authorization was created */
  timestamp: number
}