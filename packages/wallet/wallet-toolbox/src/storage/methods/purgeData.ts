import { Beef } from '@bsv/sdk'
import { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { PurgeParams, PurgeResults, StorageGetBeefOptions, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'

/**
 * Purge data from the v3 canonical schema.
 *
 * v3 has a single `transactions` table keyed by `txid` whose `processing`
 * column carries broadcast/proof state. Per-user views live in `actions`,
 * which FK back to `transactions.txid`. Outputs / commissions / tx_labels_map
 * all FK to `actions.actionId`.
 *
 * The legacy purge flow (which juggled `proven_txs`, `proven_tx_reqs`, and a
 * legacy single-table `transactions`) no longer applies: there are no parallel
 * proof tables to clean up, no orphan rows from a bridge period, and no
 * mismatch between request status and per-user transaction status.
 *
 * Supported actions:
 *  - `purgeCompleted` strips transient bytes (`raw_tx`, `input_beef`) from
 *    aged `confirmed` rows. Useful once a proof is durable and stored
 *    alongside the row.
 *  - `purgeFailed` deletes aged rows in terminal failure states
 *    (`invalid`, `doubleSpend`) together with their per-user actions and
 *    output rows.
 *  - `purgeSpent` (no-op in v3 — retained as a placeholder for the future
 *    "fully-spent confirmed tx" reaper).
 */
export async function purgeData (storage: StorageKnex, params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
  const r: PurgeResults = { count: 0, log: '' }
  const defaultAge = 1000 * 60 * 60 * 24 * 14

  const runPurgeQuery = async (pq: PurgeQuery): Promise<void> => {
    try {
      pq.sql = pq.q.toString()
      const count = await pq.q
      if (count > 0) {
        r.count += count
        r.log += `${count} ${pq.log}\n`
      }
    } catch (error_: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const e = WalletError.fromUnknown(error_)
      throw error_
    }
  }

  const k = storage.toDb(trx)

  if (params.purgeCompleted) {
    const age = params.purgeCompletedAge || defaultAge
    const before = toSqlWhereDate(new Date(Date.now() - age))

    const qs: PurgeQuery[] = []

    // Strip transient bytes from aged confirmed transactions. The merkle
    // path and proof columns are retained so the row can still produce a
    // BEEF for spending children.
    qs.push({
      log: 'confirmed transactions purged of transient data',
      q: k('transactions')
        .update({
          input_beef: null,
          raw_tx: null
        })
        .where('updated_at', '<', before)
        .where('processing', 'confirmed')
        .where(function () {
          this.orWhereNotNull('input_beef')
          this.orWhereNotNull('raw_tx')
        })
    })

    for (const q of qs) await runPurgeQuery(q)
  }

  if (params.purgeFailed) {
    const age = params.purgeFailedAge || defaultAge
    const before = toSqlWhereDate(new Date(Date.now() - age))

    // Collect txids in terminal failure states older than threshold.
    const failedTxs = await k<{ txid: string }>('transactions')
      .select('txid')
      .where('updated_at', '<', before)
      .whereIn('processing', ['invalid', 'doubleSpend'])
    const failedTxids = failedTxs.map(t => t.txid)

    if (failedTxids.length > 0) {
      const qs: PurgeQuery[] = []

      // Find the actionIds that reference these failed txids so we can
      // unwind their child rows (outputs, commissions, labels, tags).
      const actions = await k<{ actionId: number }>('actions')
        .select('actionId')
        .whereIn('txid', failedTxids)
      const actionIds = actions.map(a => a.actionId)

      if (actionIds.length > 0) {
        // Resolve outputs that hang off the doomed actions so we can clear
        // their output_tags_map entries first.
        const outputs = await k<{ outputId: number }>('outputs')
          .select('outputId')
          .whereIn('actionId', actionIds)
        const outputIds = outputs.map(o => o.outputId)
        if (outputIds.length > 0) {
          qs.push({
            log: 'failed output_tags_map deleted',
            q: k('output_tags_map').whereIn('outputId', outputIds).delete()
          })
          qs.push({
            log: 'failed outputs deleted',
            q: k('outputs').whereIn('outputId', outputIds).delete()
          })
        }

        qs.push({
          log: 'failed tx_labels_map deleted',
          q: k('tx_labels_map').whereIn('actionId', actionIds).delete()
        })
        qs.push({
          log: 'failed commissions deleted',
          q: k('commissions').whereIn('actionId', actionIds).delete()
        })

        // Restore outputs that were spent-by one of the doomed actions.
        qs.push({
          log: 'unspent outputs updated to spendable',
          q: k('outputs')
            .update({ spendable: true, spentByActionId: null })
            .whereIn('spentByActionId', actionIds)
        })

        qs.push({
          log: 'failed tx_audit deleted',
          q: k('tx_audit').whereIn('actionId', actionIds).delete()
        })

        qs.push({
          log: 'failed actions deleted',
          q: k('actions').whereIn('actionId', actionIds).delete()
        })
      }

      // Drop the canonical transactions rows themselves. Audit rows keyed by
      // txid (no actionId) are removed alongside.
      qs.push({
        log: 'failed tx_audit (txid-only) deleted',
        q: k('tx_audit').whereIn('txid', failedTxids).delete()
      })
      qs.push({
        log: 'failed transactions deleted',
        q: k('transactions').whereIn('txid', failedTxids).delete()
      })

      for (const q of qs) await runPurgeQuery(q)
    }
  }

  if (params.purgeSpent) {
    // v3 placeholder: fully-spent-confirmed-transaction cleanup is not yet
    // implemented against the per-action shape. We still warm the BEEF cache
    // for known-spendable UTXOs so that any subsequent purge has the proofs
    // available, mirroring the legacy ordering.
    const beef = new Beef()
    const utxos = await storage.findOutputs({
      partial: { spendable: true },
      txStatus: ['sending', 'unproven', 'completed', 'nosend']
    })
    for (const utxo of utxos) {
      const options: StorageGetBeefOptions = {
        mergeToBeef: beef,
        ignoreServices: true
      }
      if (utxo.txid) {
        try {
          await storage.getBeefForTransaction(utxo.txid, options)
        } catch (error_: unknown) {
          const e = WalletError.fromUnknown(error_)
          if (!isMissingLocalBeefError(e, utxo.txid, storage.chain)) throw error_
        }
      }
    }
  }

  return r
}

interface PurgeQuery {
  q: Knex.QueryBuilder<any, number>
  sql?: string
  log: string
}

function toSqlWhereDate (d: Date): string {
  let s = d.toISOString()
  s = s.replace('T', ' ')
  s = s.replace('Z', '')
  return s
}

function isMissingLocalBeefError (e: WalletError, txid: string, chain: string): boolean {
  if (e.code !== 'WERR_INVALID_PARAMETER') return false
  const parameter = (e as WalletError & { parameter?: string }).parameter
  if (
    parameter === `txid ${txid}` &&
    e.message === `The txid ${txid} parameter must be valid transaction on chain ${chain}`
  ) {
    return true
  }
  return parameter === 'txid' && /^The txid parameter must be known to storage\. .+ is not known\.$/.test(e.message)
}
