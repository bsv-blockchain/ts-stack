/**
 * Permission and fee management types for MessageBox system
 */

import { PubKeyHex } from '@bsv/sdk'

/**
 * Parameters for setting message box permissions
 */
export interface SetMessageBoxPermissionParams {
  /** The messageBox type (e.g., 'notifications', 'inbox') */
  messageBox: string
  /** Optional sender - if omitted, sets box-wide default */
  sender?: string
  /** Recipient fee: -1=block all, 0=always allow, >0=satoshi amount required */
  recipientFee: number
}

/**
 * Parameters for getting message box permissions
 */
export interface GetMessageBoxPermissionParams {
  /** The recipient's identity key */
  recipient: string
  /** The messageBox type */
  messageBox: string
  /** Optional sender - if omitted, gets box-wide default */
  sender?: string
}

/**
 * Permission response from server
 */
export interface MessageBoxPermission {
  /** Sender identity key (null for box-wide defaults) */
  sender: string | null
  /** MessageBox type */
  messageBox: string
  /** Recipient fee setting */
  recipientFee: number
  /** Permission status derived from recipientFee */
  status: 'always_allow' | 'blocked' | 'payment_required'
  /** Creation timestamp */
  createdAt: string
  /** Last update timestamp */
  updatedAt: string
}

/**
 * Fee quote response
 */
export interface MessageBoxQuote {
  /** Server delivery fee */
  deliveryFee: number
  /** Recipient fee */
  recipientFee: number
  /** Delivery agent identity key */
  deliveryAgentIdentityKey: PubKeyHex
}

/**
 * Parameters for listing permissions
 */
export interface ListPermissionsParams {
  /** Optional messageBox filter */
  messageBox?: string
  /** Optional pagination limit */
  limit?: number
  /** Optional pagination offset */
  offset?: number
}

/**
 * Parameters for getting fee quote
 */
export interface GetQuoteParams {
  /** Recipient identity key */
  recipient: string | string[]
  /** MessageBox type */
  messageBox: string
}
export interface SendListParams {
  recipients: PubKeyHex[]
  messageBox: string
  body: string | object
  skipEncryption?: boolean
}

export interface SendListResult {
  status: 'success' | 'partial' | 'error'
  description: string
  sent: Array<{ recipient: PubKeyHex, messageId: string }>
  blocked: PubKeyHex[]
  failed: Array<{ recipient: PubKeyHex, error: string }>
  totals?: {
    deliveryFees: number
    recipientFees: number
    totalForPayableRecipients: number
  }
}
export interface MessageBoxMultiQuote {
  quotesByRecipient: Array<{
    recipient: PubKeyHex
    messageBox: string
    deliveryFee: number
    recipientFee: number
    status: 'blocked' | 'always_allow' | 'payment_required'
  }>
  totals?: {
    deliveryFees: number
    recipientFees: number
    totalForPayableRecipients: number
  }
  blockedRecipients: PubKeyHex[]
  /**
   * When multiple overlays are involved, each host returns its own
   * delivery agent identity key. This map preserves them.
   * If all recipients resolve to one host, you’ll just have one entry.
   */
  deliveryAgentIdentityKeyByHost: Record<string, string>
}
