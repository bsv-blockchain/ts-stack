import { P2PKH, PublicKey } from '@bsv/sdk'
import { PAYMENT_PROTOCOL_ID, isIdentityKey } from '../types.js'
import type { IncomingPaymentInput, PubKeyHex, WalletLike } from '../types.js'
import {
  invalidPayment,
  isByteArray,
  parsePaymentTransaction,
  plainRecord,
  tokenFields
} from './validate.js'

/**
 * Remembers which payments were already internalized, so a re-delivered payment (the
 * payer retried after losing the ack) is acknowledged without internalizing it again.
 * Keys come from {@link paymentKey}.
 */
export interface SeenStore {
  has(key: string): boolean | Promise<boolean>
  add(key: string): void | Promise<void>
}

/**
 * Idempotency key of one payment output: `txid:outputIndex:prefix:suffix`. The parts
 * cannot contain `:` (hex, digits, base64), so distinct payments never share a key.
 */
export function paymentKey(
  txid: string,
  outputIndex: number,
  prefix: string,
  suffix: string
): string {
  return `${txid}:${outputIndex}:${prefix}:${suffix}`
}

interface VerifiedPayment {
  txid: string
  satoshis: number
  sender: PubKeyHex
  transaction: number[]
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
}

async function verify(
  wallet: WalletLike,
  p: IncomingPaymentInput,
  originator: string | undefined
): Promise<VerifiedPayment> {
  const payment = plainRecord(p)
  const sender = payment?.sender
  if (payment === undefined || !isIdentityKey(sender)) {
    throw invalidPayment('Payment sender is not an identity key')
  }
  const fields = tokenFields(payment.token, payment.outputIndex)
  const { transaction, outputIndex, derivationPrefix, derivationSuffix, amount } = fields
  if (!isByteArray(transaction)) throw invalidPayment('Payment transaction is not a byte array')
  const tx = parsePaymentTransaction(transaction)

  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: PAYMENT_PROTOCOL_ID,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: sender,
      forSelf: true
    },
    originator
  )
  const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
  const output = tx.outputs[outputIndex]
  if (
    output === undefined ||
    output.satoshis !== amount ||
    output.lockingScript.toHex() !== expected
  ) {
    throw invalidPayment('Payment output does not pay the derived key the stated amount')
  }
  return {
    txid: tx.id('hex'),
    satoshis: amount,
    sender,
    // a number array for every wallet, also those whose transport cannot carry a Uint8Array
    transaction: Array.isArray(transaction) ? transaction : Array.from(transaction),
    outputIndex,
    derivationPrefix,
    derivationSuffix
  }
}

/**
 * Checks that a payment is spendable by this wallet: output `outputIndex` (the token's,
 * else `p.outputIndex`, else 0) must be P2PKH to the BRC-29 key derived with
 * `PAYMENT_PROTOCOL_ID`, keyID `"<prefix> <suffix>"`, counterparty `p.sender`,
 * `forSelf: true`, and carry exactly `token.amount` satoshis. `p.sender` must be the
 * peer's authenticated identity key.
 *
 * @throws WebRTPayError `invalid_payment` when the payment is malformed or does not pay
 * this wallet; wallet errors from `getPublicKey` propagate unchanged.
 */
export async function verifyDirectPayment(
  wallet: WalletLike,
  p: IncomingPaymentInput,
  o: { originator?: string } = {}
): Promise<{ txid: string; satoshis: number }> {
  const { txid, satoshis } = await verify(wallet, p, o.originator)
  return { txid, satoshis }
}

/** Options for {@link acceptDirectPayment}. */
export interface AcceptDirectPaymentOptions {
  /** Passed to every wallet call. */
  originator?: string
  /** Where accepted payments are recorded; without it every delivery is internalized. */
  seen?: SeenStore
  labels?: string[]
  description?: string
  /**
   * Called with what `seen.add` threw or rejected with after the wallet accepted the
   * payment. The payment still counts as accepted; anything this throws is ignored.
   */
  onSeenError?: (e: unknown) => void
}

/**
 * Verifies a direct payment and internalizes it as a `wallet payment`, once.
 *
 * Order: {@link verifyDirectPayment}; if `seen` already has the payment's
 * {@link paymentKey}, return `duplicate` without internalizing; otherwise
 * `internalizeAction` (labels `['peerpay', 'direct', 'inbound']`, description
 * `'Received direct BSV'` unless overridden), require `accepted === true`, then record
 * the key in `seen`. Once the wallet has the payment it is `accepted`, even when recording
 * it fails (that failure goes to `onSeenError`, and a re-delivery is then internalized
 * again, as without a `seen` store).
 *
 * @throws WebRTPayError `invalid_payment` when verification fails (nothing is
 * internalized). A wallet error from `internalizeAction` propagates unchanged, and a
 * result without `accepted: true` throws a plain `Error`; in both cases the key is not
 * recorded, so the payment can be retried.
 */
export async function acceptDirectPayment(
  wallet: WalletLike,
  p: IncomingPaymentInput,
  o: AcceptDirectPaymentOptions = {}
): Promise<{ txid: string; status: 'accepted' | 'duplicate' }> {
  const v = await verify(wallet, p, o.originator)
  const key = paymentKey(v.txid, v.outputIndex, v.derivationPrefix, v.derivationSuffix)
  if (o.seen !== undefined && (await o.seen.has(key))) return { txid: v.txid, status: 'duplicate' }

  const result = await wallet.internalizeAction(
    {
      tx: v.transaction,
      outputs: [
        {
          outputIndex: v.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            senderIdentityKey: v.sender,
            derivationPrefix: v.derivationPrefix,
            derivationSuffix: v.derivationSuffix
          }
        }
      ],
      labels: o.labels ?? ['peerpay', 'direct', 'inbound'],
      description: o.description ?? 'Received direct BSV'
    },
    o.originator
  )
  if (result?.accepted !== true) throw new Error('The wallet did not accept the payment')
  try {
    await o.seen?.add(key)
  } catch (e) {
    // The wallet holds the payment: refusing it now would tell the payer it failed.
    try {
      o.onSeenError?.(e)
    } catch {
      // a hook that throws changes nothing
    }
  }
  return { txid: v.txid, status: 'accepted' }
}
