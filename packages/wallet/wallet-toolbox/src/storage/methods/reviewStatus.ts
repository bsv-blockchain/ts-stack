import { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'
import type { ProvenTxReqStatus } from '../../sdk/types'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableOutput } from '../schema/tables/TableOutput'

const provenTxReqStatusesSafeForInputRestore: ProvenTxReqStatus[] = ['invalid', 'doubleSpend']

/**
 * Looks for unpropagated state:
 *
 * 1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
 * 2. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.
 * 3. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.
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

  // Post-V7-cutover: `proven_txs` → `proven_txs_legacy`, `proven_tx_reqs` →
  // `proven_tx_reqs_legacy`, and `transactions` (legacy-shaped with `status`
  // column) → `transactions_legacy`.  Pre-cutover: the original table names.
  const txTable = await storage.provenTxsTableName()    // proven_txs or proven_txs_legacy
  const reqTable = await storage.provenTxReqsTableName() // proven_tx_reqs or proven_tx_reqs_legacy
  // The legacy-shaped `transactions` table (with status, satoshis, etc. columns).
  // Post-cutover that table is renamed to `transactions_legacy`; the new
  // `transactions` table has `processing` instead of `status`.
  const txnsTable = txTable === 'proven_txs_legacy' ? 'transactions_legacy' : 'transactions'

  const qs: ReviewStatusQuery[] = []

  qs.push(
    {
      log: 'transactions updated to status of \'failed\' where provenTxReq with matching txid is \'invalid\'',
      /*
          UPDATE transactions SET status = 'failed'
          WHERE exists(select 1 from proven_tx_reqs as r where transactions.txid = r.txid and r.status = 'invalid')
          */
      q: k<TableTransaction>(txnsTable)
        .update({ status: 'failed' })
        .whereNot({ status: 'failed' })
        .whereExists(function () {
          this.select(k.raw(1))
            .from(`${reqTable} as r`)
            .whereRaw(`${txnsTable}.txid = r.txid and r.status = 'invalid'`)
        })
    },
    {
      log: 'outputs updated to spendable where spentBy is a failed transaction with no blocking ProvenTxReq',
      /*
          UPDATE outputs SET spentBy = null, spendable = 1
          where exists(select 1 from transactions as t where outputs.spentBy = t.transactionId and t.status = 'failed')
          and not exists(select 1 from proven_tx_reqs as r where r.txid = t.txid and r.status not in ('invalid', 'doubleSpend'))
          */
      q: k<TableOutput>('outputs')
        .update({ spentBy: null as unknown as undefined, spendable: true })
        .whereExists(function () {
          this.select(k.raw(1))
            .from(`${txnsTable} as t`)
            .whereRaw(`outputs.spentBy = t.transactionId and t.status = 'failed'`)
            .whereNotExists(function () {
              // A failed transaction can still be reconciled from active or valid reqs.
              // Only terminal failure reqs are safe for input restoration.
              this.select(k.raw(1))
                .from(`${reqTable} as r`)
                .whereRaw('r.txid = t.txid')
                .whereNotIn('r.status', provenTxReqStatusesSafeForInputRestore)
            })
        })
    },
    {
      log: 'transactions updated with provenTxId and status of \'completed\' where provenTx with matching txid exists',
      /*
          UPDATE transactions SET status = 'completed', provenTxId = p.provenTxId
          FROM proven_txs p
          WHERE transactions.txid = p.txid AND transactions.provenTxId IS NULL
          */
      q: k<TableTransaction>(txnsTable)
        .update({
          status: 'completed',
          provenTxId: k.raw(`(SELECT provenTxId FROM ${txTable} AS p WHERE ${txnsTable}.txid = p.txid)`)
        })
        .whereNull('provenTxId')
        .whereExists(function () {
          this.select(k.raw(1)).from(`${txTable} as p`).whereRaw(`${txnsTable}.txid = p.txid`)
        })
    }
  )

  for (const q of qs) await runReviewStatusQuery(q)

  return r
}

interface ReviewStatusQuery {
  q: Knex.QueryBuilder<any, number>
  sql?: string
  log: string
}
