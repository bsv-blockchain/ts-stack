import { Transaction, type WalletInterface } from '@bsv/sdk'

import { computePayouts } from '../protocol/fibonacci.js'
import { paymentEnvelope, payoutLockingScript, type PaymentEnvelope } from '../protocol/payment.js'
import type { Arrival } from './race.js'

export interface PayoutPlan {
  /** Host identity key. */
  host: string
  url: string
  rank: number
  satoshis: number
}

export interface Settlement {
  txid: string
  /** One envelope per paid host, keyed by identity key; only the suffix differs. */
  envelopes: Map<string, PaymentEnvelope>
}

/** Fibonacci split over the ranked hosts. Shares are non-increasing, so zeros only trail. */
export function planPayouts(ranked: Arrival[], feeSats: number): PayoutPlan[] {
  if (ranked.length === 0) return []
  const payouts = computePayouts(feeSats, ranked.length)
  return ranked
    .map((arrival, index) => ({
      host: arrival.host,
      url: arrival.url,
      rank: index + 1,
      satoshis: payouts[index]
    }))
    .filter(plan => plan.satoshis > 0)
}

/**
 * Builds the single payout transaction. A normal action is used, so the client wallet
 * broadcasts: a host's `internalizeAction` broadcasts on receipt anyway, and aborting a
 * `noSend` action after dispatch would leave the wallet believing spent inputs are free.
 */
export async function settle(
  wallet: WalletInterface,
  queryId: string,
  plans: PayoutPlan[],
  originator?: string
): Promise<Settlement> {
  if (plans.length === 0) throw new Error('No payouts to settle')
  const scripts = await Promise.all(
    plans.map(
      async plan =>
        await payoutLockingScript(wallet, plan.host, queryId, plan.rank, false, originator)
    )
  )
  const result = await wallet.createAction(
    {
      description: 'BRC-178 query payout',
      labels: ['brc178'],
      outputs: plans.map((plan, index) => ({
        lockingScript: scripts[index],
        satoshis: plan.satoshis,
        outputDescription: `Rank ${plan.rank} payout`
      })),
      options: { randomizeOutputs: false }
    },
    originator
  )
  if (result.tx === undefined) throw new Error('The wallet returned no transaction')
  // `CreateActionResult.tx` is typed as `Byte[] | Uint8Array`; `paymentEnvelope` takes `number[]`.
  const atomicBeef = Array.isArray(result.tx) ? result.tx : Array.from(result.tx)
  const transaction = Transaction.fromAtomicBEEF(atomicBeef)
  for (const [index, plan] of plans.entries()) {
    const paid = transaction.outputs.some(
      output =>
        output.lockingScript.toHex() === scripts[index] && (output.satoshis ?? 0) === plan.satoshis
    )
    if (!paid) throw new Error(`The wallet transaction does not pay rank ${plan.rank}`)
  }
  const envelopes = new Map<string, PaymentEnvelope>()
  for (const plan of plans) {
    envelopes.set(plan.host, paymentEnvelope(queryId, plan.rank, atomicBeef))
  }
  return { txid: result.txid ?? transaction.id('hex'), envelopes }
}
