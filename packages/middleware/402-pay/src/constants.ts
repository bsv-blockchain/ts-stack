import type { WalletProtocol } from '@bsv/sdk'

/** BRC-29 protocol ID for key derivation */
export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

/** Header prefix for all BRC-121 headers */
export const HEADER_PREFIX = 'x-bsv-'

/** Header names */
export const HEADERS = {
  /** Server → Client: required satoshi amount */
  SATS: `${HEADER_PREFIX}sats`,
  /** Server → Client: server identity public key */
  SERVER: `${HEADER_PREFIX}server`,
  /** Client → Server: base64-encoded BEEF transaction */
  BEEF: `${HEADER_PREFIX}beef`,
  /** Client → Server: client identity public key */
  SENDER: `${HEADER_PREFIX}sender`,
  /** Client → Server: base64-encoded derivation prefix */
  NONCE: `${HEADER_PREFIX}nonce`,
  /** Client → Server: Unix millisecond timestamp */
  TIME: `${HEADER_PREFIX}time`,
  /** Client → Server: output index (decimal string) */
  VOUT: `${HEADER_PREFIX}vout`
} as const

/** Default payment window: 30 seconds */
export const DEFAULT_PAYMENT_WINDOW_MS = 30_000
