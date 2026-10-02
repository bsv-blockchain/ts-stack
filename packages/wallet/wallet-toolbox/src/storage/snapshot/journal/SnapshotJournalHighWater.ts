import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'

/** Fixed indexed head seeks in the pinned view. MySQL callers retain the exclusive writer barrier during pinning. */
export async function readSnapshotJournalHighWater(
  k: Knex,
  userId: number,
  minimum: SnapshotJournalRevision,
  floor: SnapshotJournalRevision
): Promise<SnapshotJournalRevision> {
  const client = k.client.config.client,
    local = client === 'sqlite3' || client === 'better-sqlite3'
  if (!local && client !== 'mysql' && client !== 'mysql2')
    throw new WERR_INVALID_OPERATION('Unsupported snapshot journal SQL driver')
  if (!Number.isSafeInteger(userId) || userId < 1) throw new WERR_INVALID_OPERATION('Invalid snapshot journal profile')
  snapshotJournalRevision(minimum)
  snapshotJournalRevision(floor)
  if (compareSnapshotJournalRevisions(minimum, floor) < 0)
    throw new WERR_INVALID_OPERATION('Snapshot journal continuity was collected')
  let high = minimum
  const streams = [
    ...Array.from({ length: 13 }, (_, tableId) => ({ stream: 'scope', tableId })),
    ...[8, 9].map(tableId => ({ stream: 'physical', tableId }))
  ]
  await runInSeries(streams, async ({ stream, tableId }) => {
    const table = 'snapshot_journal_' + stream
    const query = k
      .from(k.raw(local ? '?? AS ?? INDEXED BY ??' : '?? AS ?? FORCE INDEX (??)', [table, 'j', table + '_page']))
      .where('j.tableId', tableId)
      .select({ revisionText: snapshotJournalRevisionText(k, 'j.revision') })
      .orderBy('j.revision', 'desc')
      .first()
    if (stream === 'scope') query.where('j.userId', userId)
    const row: { revisionText: unknown } | undefined = await query
    if (row !== undefined) {
      const value = snapshotJournalRevision(row.revisionText)
      if (compareSnapshotJournalRevisions(value, high) > 0) high = value
    }
  })
  return high
}
