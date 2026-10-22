import type { SnapshotJournalCurrentDataResult } from './SnapshotJournalTypes'
export type { SnapshotJournalCurrentDataResult } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { withSnapshotJournalPrimaryCommitFence } from './SnapshotJournalPrimaryCommitFence'
import { snapshotJournalMetadataQuery } from './SnapshotJournalPage'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'

/** One indexed metadata result per stream, with all source writers excluded.
 * A consumed clock position alone is not a data change. Conservative physical
 * global changes request a fresh copy; no unbounded membership scan is allowed
 * in a primary cutover. Paging, proof and observers remain outside this fence. */
export async function withSnapshotJournalCurrentDataFence<T>(
  k: Knex.Transaction,
  userId: number,
  since: SnapshotJournalRevision,
  ceiling: SnapshotJournalRevision,
  verify: () => Promise<void>,
  commit: () => Promise<T>
): Promise<SnapshotJournalCurrentDataResult<T>> {
  snapshotJournalRevision(since)
  snapshotJournalRevision(ceiling)
  return await withSnapshotJournalPrimaryCommitFence<SnapshotJournalCurrentDataResult<T>>(
    k,
    userId,
    async () => {
      if (['mysql', 'mysql2'].includes(String(k.client.config.client))) {
        // Every owned source observer takes FOR SHARE on this same clock. Acquire
        // it exclusively before establishing the view used for current metadata.
        const clocks = await k('snapshot_journal_clock').where('id', 1).select('id').limit(2).forUpdate().noWait()
        if (clocks.length !== 1) throw new WERR_INVALID_OPERATION('Journal data cutover clock is unavailable')
      }
      await verify()
    },
    async () => {
      const streams = [
        ...Array.from({ length: 13 }, (_, tableId) => ({ stream: 'scope' as const, tableId })),
        { stream: 'physical' as const, tableId: 8 },
        { stream: 'physical' as const, tableId: 9 }
      ]
      for (const stream of streams) {
        const changed = await snapshotJournalMetadataQuery(k, {
          ...stream,
          userId,
          floor: snapshotJournalRevision('0'),
          low: since,
          high: ceiling,
          limit: 1
        })
        if (changed.length !== 0) return { current: false }
      }
      return { current: true, value: await commit() }
    }
  )
}
