import { P2PKH, PublicKey, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

import { isCanonicalBase64 } from './encoding.js'
import { isHashHex, isPlainObject } from './query.js'

export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

const MAX_TRANSACTION_BASE64 = 8 * 1024 * 1024
const MAX_DERIVATION_CHARS = 512

export interface PaymentEnvelope {
  derivationPrefix: string
  derivationSuffix: string
  transaction: string
}

/** `wallet.internalizeAction` accepts only standard base64, so the query ID bytes are re-encoded. */
export function derivationPrefix(queryId: string): string {
  if (!isHashHex(queryId)) throw new TypeError('queryId must be 32 bytes of lowercase hex')
  return Utils.toBase64(Utils.toArray(queryId, 'hex'))
}

/** Two-byte big-endian rank; rank 1 is `AAE=`. */
export function derivationSuffix(rank: number): string {
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > 0xffff) {
    throw new RangeError('rank must be an integer from 1 to 65535')
  }
  return Utils.toBase64([rank >> 8, rank & 0xff])
}

export function paymentEnvelope(
  queryId: string,
  rank: number,
  atomicBeef: number[]
): PaymentEnvelope {
  return {
    derivationPrefix: derivationPrefix(queryId),
    derivationSuffix: derivationSuffix(rank),
    transaction: Utils.toBase64(atomicBeef)
  }
}

export function parsePaymentEnvelope(value: unknown): PaymentEnvelope {
  if (!isPlainObject(value)) throw new TypeError('Payment must be a JSON object')
  const { derivationPrefix: prefix, derivationSuffix: suffix, transaction } = value
  if (!isCanonicalBase64(prefix) || prefix.length === 0 || prefix.length > MAX_DERIVATION_CHARS) {
    throw new TypeError('derivationPrefix must be canonical base64')
  }
  if (!isCanonicalBase64(suffix) || suffix.length === 0 || suffix.length > MAX_DERIVATION_CHARS) {
    throw new TypeError('derivationSuffix must be canonical base64')
  }
  if (
    !isCanonicalBase64(transaction) ||
    transaction.length === 0 ||
    transaction.length > MAX_TRANSACTION_BASE64
  ) {
    throw new TypeError('transaction must be canonical base64 Atomic BEEF')
  }
  return { derivationPrefix: prefix, derivationSuffix: suffix, transaction }
}

/**
 * P2PKH script for the BRC-29 key bound to one query and one rank. The payer derives the host's
 * child key (`forSelf: false`); the host derives its own (`forSelf: true`). BRC-42 makes them equal.
 */
export async function payoutLockingScript(
  wallet: WalletInterface,
  counterparty: string,
  queryId: string,
  rank: number,
  forSelf: boolean,
  originator?: string
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${derivationPrefix(queryId)} ${derivationSuffix(rank)}`,
      counterparty,
      forSelf
    },
    originator
  )
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
}
