import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'

import {
  derivationPrefix,
  derivationSuffix,
  payoutLockingScript,
  type PaymentEnvelope
} from '../protocol/payment.js'

export type PaymentVerification =
  | { ok: true; txid: string; outputIndex: number; satoshis: number }
  | {
      ok: false
      reason: 'malformed' | 'no-output' | 'underpaid' | 'rejected'
      required?: number
      paid?: number
    }

/**
 * Verifies a BRC-178 payout for this host. `@bsv/payment-express-middleware` cannot be used: it
 * demands a server-minted derivation prefix and always internalizes output 0. Here the prefix is
 * the query ID, and the host finds its own output by deriving the script it expects.
 */
export async function verifyAndInternalizePayment(args: {
  wallet: WalletInterface
  envelope: PaymentEnvelope
  queryId: string
  rank: number
  clientIdentityKey: string
  requiredSats: number
  originator?: string
}): Promise<PaymentVerification> {
  const { wallet, envelope, queryId, rank, clientIdentityKey, requiredSats, originator } = args
  if (
    envelope.derivationPrefix !== derivationPrefix(queryId) ||
    envelope.derivationSuffix !== derivationSuffix(rank)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  const atomicBeef = Utils.toArray(envelope.transaction, 'base64')
  let transaction: Transaction
  try {
    transaction = Transaction.fromAtomicBEEF(atomicBeef)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const expected = await payoutLockingScript(
    wallet,
    clientIdentityKey,
    queryId,
    rank,
    true,
    originator
  )
  const outputIndex = transaction.outputs.findIndex(
    output => output.lockingScript.toHex() === expected
  )
  if (outputIndex === -1) return { ok: false, reason: 'no-output' }
  const satoshis = transaction.outputs[outputIndex].satoshis ?? 0
  if (satoshis < requiredSats) {
    return { ok: false, reason: 'underpaid', required: requiredSats, paid: satoshis }
  }
  try {
    const result = await wallet.internalizeAction(
      {
        tx: atomicBeef,
        outputs: [
          {
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: envelope.derivationPrefix,
              derivationSuffix: envelope.derivationSuffix,
              senderIdentityKey: clientIdentityKey
            }
          }
        ],
        description: 'BRC-178 query payout',
        labels: ['brc178']
      },
      originator
    )
    if (result.accepted !== true) return { ok: false, reason: 'rejected' }
  } catch {
    return { ok: false, reason: 'rejected' }
  }
  return { ok: true, txid: transaction.id('hex'), outputIndex, satoshis }
}
