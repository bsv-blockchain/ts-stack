import type { Knex } from 'knex'
import type { TableSettings, TableUser } from '../../schema/tables'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  createSnapshotSyncContentRevision,
  parseSnapshotSyncContentPosition,
  type SnapshotSyncContentPosition,
  type SnapshotSyncContentRevision
} from '../SnapshotSyncContentRevision'
import { snapshotJournalMetadataQuery } from './SnapshotJournalPage'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'
import { runInSeries } from '../../../utility/runInSeries'

/** Read at most one indexed metadata value from each original stream in the
 * caller's already owned coherent transaction. This helper does not establish
 * backend/schema/lease authority and never turns copied coordinates into it. */
export async function readSnapshotJournalContentRevision(
  k: Knex.Transaction,
  input: {
    binding: string
    floor: string
    highWater: string
    sourceStorage: TableSettings
    user: TableUser
    primaryEpoch: string
  },
  selectedSince?: SnapshotSyncContentPosition
): Promise<Readonly<SnapshotSyncContentRevision>> {
  if (!k.isTransaction) throw new WERR_INVALID_OPERATION('Content revision requires its actual retained transaction')
  const since = selectedSince === undefined ? undefined : parseSnapshotSyncContentPosition(selectedSince),
    highWater = snapshotJournalRevision(input.highWater),
    revisions: string[] = [],
    streams = [
      ...Array.from({ length: 13 }, (_, tableId) => ({ stream: 'scope' as const, tableId })),
      { stream: 'physical' as const, tableId: 8 },
      { stream: 'physical' as const, tableId: 9 }
    ]
  await runInSeries(streams, async stream => {
    const rows: Array<{ revisionText: unknown }> = await snapshotJournalMetadataQuery(k, {
      ...stream,
      userId: input.user.userId,
      floor: snapshotJournalRevision('0'),
      low: snapshotJournalRevision('0'),
      high: highWater,
      limit: 1
    })
      .clearSelect()
      .select({ revisionText: snapshotJournalRevisionText(k, 'j.revision') })
      .clearOrder()
      .orderBy('j.revision', 'desc')
    if (rows.length > 1) throw new WERR_INVALID_OPERATION('Content revision metadata exceeded its indexed bound')
    revisions.push(rows.length === 0 ? '0' : snapshotJournalRevision(rows[0].revisionText))
  })
  const current = createSnapshotSyncContentRevision({ ...input, highWater, revisions })
  if (since === undefined || since.binding !== current.binding || since.metadata !== current.metadata) return current
  const previous = snapshotJournalRevision(since.highWater)
  if (compareSnapshotJournalRevisions(previous, highWater) > 0)
    throw new WERR_INVALID_OPERATION('Content position exceeds its actual source high-water')
  if (
    compareSnapshotJournalRevisions(previous, snapshotJournalRevision(current.floor)) < 0 ||
    revisions.some(value => compareSnapshotJournalRevisions(snapshotJournalRevision(value), previous) > 0)
  )
    return current
  return Object.freeze({ ...current, unchangedSince: previous })
}
