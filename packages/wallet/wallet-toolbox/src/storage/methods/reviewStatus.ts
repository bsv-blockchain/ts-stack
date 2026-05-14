import { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'
import type { ProcessingStatus } from '../../sdk/types'

/**
 * `ProcessingStatus` values that are safe for restoring spentBy outputs back
 * to spendable. These mirror the legacy `ProvenTxReqStatus` set ('invalid',
 * 'doubleSpend') — anything else (queued/sending/sent/seen/...) might still
 * confirm and so must keep the output marked spent.
 */
const processingStatusesSafeForInputRestore: ProcessingStatus[] = ['invalid', 'doubleSpend']

/**
 * Looks for unpropagated state in the v3 canonical `transactions` table:
 *
 * 1. Marks outputs spendable again where `spentByActionId` references an
 *    action whose underlying transaction has terminally failed (`invalid` or
 *    `doubleSpend`) — i.e. the would-be spending transaction will never make
 *    it onto chain.
 *
 * In v3 there is no longer a separate `proven_tx_reqs.status` column to
 * synchronise against per-user `transactions.status`; broadcast/proof state
 * lives directly on `transactions.processing`. Steps (1) and (3) from the
 * legacy implementation collapsed into the canonical row already, so this
 * routine reduces to a single output-restoration sweep.
 *
 * @param storage
 * @param args
 * @returns
 */
export async function reviewStatus (
  storage: StorageKnex,
  args: { agedLimit: Date, trx?: TrxToken }
): Promise<{ log: string }> {
  const r: { log: string } = { log: '' }

  const runReviewStatusQuery = async <T extends object>(pq: ReviewStatusQuery): Promise<void> => {
    try {
      pq.sql = pq.q.toString()
      const count = await pq.q
      if (count > 0) {
        r.log += `${count} ${pq.log}\n`
      }
    } catch (error_: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const e = WalletError.fromUnknown(error_)
      throw error_
    }
  }

  const k = storage.toDb(args.trx)

  const qs: ReviewStatusQuery[] = []

  qs.push({
    log: 'outputs updated to spendable where the spending action references a transaction in a terminal failure state',
    /*
        UPDATE outputs SET spentByActionId = null, spendable = 1
        WHERE EXISTS (
          SELECT 1 FROM actions a
          JOIN transactions t ON t.txid = a.txid
          WHERE a.actionId = outputs.spentByActionId
            AND t.processing IN ('invalid', 'doubleSpend')
        )
    */
    q: k('outputs')
      .update({ spentByActionId: null, spendable: true })
      .whereExists(function () {
        this.select(k.raw(1))
          .from('actions as a')
          .join('transactions as t', 't.txid', 'a.txid')
          .whereRaw('a.actionId = outputs.spentByActionId')
          .whereIn('t.processing', processingStatusesSafeForInputRestore)
      })
  })

  for (const q of qs) await runReviewStatusQuery(q)

  return r
}

interface ReviewStatusQuery {
  q: Knex.QueryBuilder<any, number>
  sql?: string
  log: string
}
