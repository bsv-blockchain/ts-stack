import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { numeric } from '../schema/snapshotSqliteMembership'
import { names } from '../schema/snapshotSqliteIndexGeneration'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { runInSeries } from '../../utility/runInSeries'

/** Only a genuine owned private stage can establish this shortcut. Every
 * physical and membership stream is actually empty in the same native writer;
 * no plaintext payload is fetched and no populated/resumed stream is skipped.
 * An already complete validated generation is idempotently complete. The
 * original public bootstrap API and its page semantics remain unchanged. */
export async function completeBrc38OwnedEmptyBootstrap(
  store: KnexBrc38StagingStore,
  policy: SnapshotJournalReceiptPolicy
): Promise<boolean> {
  if (!(store instanceof KnexBrc38StagingStore)) throw new Error('An actual owned private stage is required')
  const assertOwned = () => KnexBrc38StagingStore.prototype.assertPrivateNativeDestination.call(store, store.knex)
  assertOwned()
  let failed = false,
    original: unknown
  try {
    return await store.knex.transaction(async trx => {
      try {
        // Acquire the actual SQLite writer before generation or emptiness reads.
        if (
          (await trx('snapshot_journal_bootstrap')
            .where({ id: 1 })
            .update({ stream: trx.ref('stream') })) !== 1
        )
          throw new Error('Private empty bootstrap metadata is absent')
        const generation = await readSnapshotJournalSqliteGeneration(trx, policy)
        if (generation.complete) {
          assertOwned()
          return true
        }
        if (!generation.enabled) {
          assertOwned()
          return false
        }
        const positions: Array<{
          stream: number
          cursor: string | null
          rowLimit: number | null
          rowsUsed: number
        }> = await trx('snapshot_journal_bootstrap')
          .where({ id: 1 })
          .select('stream', 'cursor', 'rowLimit', 'rowsUsed')
          .limit(2)
        const position = positions[0]
        if (
          positions.length !== 1 ||
          position?.stream !== 0 ||
          position.cursor !== null ||
          position.rowsUsed !== 0 ||
          (position.rowLimit !== null && position.rowLimit !== 1000)
        ) {
          assertOwned()
          return false
        }
        // These are the exact thirteen physical and four membership streams used
        // by the current SQLite bootstrap. Their schema was validated above.
        const tables = [
          ...numeric.map(source => source.table),
          'tx_labels_map',
          'output_tags_map',
          'certificate_fields',
          names.profile,
          names.relation,
          names.certificate,
          names.keys
        ]
        if (tables.length !== 17 || new Set(tables).size !== 17)
          throw new Error('Private empty bootstrap stream definition differs')
        let occupied = false
        await runInSeries(['users', ...tables], async table => {
          assertOwned()
          const rows = await trx(table).select(trx.raw('1 AS occupied')).limit(1)
          if (rows.length !== 0) occupied = true
        })
        if (occupied) {
          assertOwned()
          return false
        }
        assertOwned()
        // The same fixed allowance as ordinary private initialization. Only
        // actual zero examined records permit a terminal cursor in one commit.
        if (
          (await trx('snapshot_journal_bootstrap')
            .where({ id: 1, stream: 0, cursor: null, rowsUsed: 0 })
            .update({ stream: 17, cursor: null, rowLimit: 1000, rowsUsed: 0 })) !== 1
        )
          throw new Error('Private empty bootstrap state changed')
        assertOwned()
        return true
      } catch (cause) {
        failed = true
        original = cause
        throw cause
      }
    })
  } catch (error_) {
    if (failed && error_ !== original)
      throw new AggregateError([original, error_], 'Private empty bootstrap and rollback failed')
    throw error_
  }
}
