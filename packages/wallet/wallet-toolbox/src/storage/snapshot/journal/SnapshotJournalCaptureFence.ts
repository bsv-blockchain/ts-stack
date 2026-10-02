import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  compareSnapshotJournalRevisions,
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'
import { SNAPSHOT_JOURNAL_SQLITE_ADVANCE } from './SnapshotJournalSqliteClock'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid snapshot journal capture barrier or clock')
}

async function sqliteFence(k: Knex): Promise<SnapshotJournalRevision | undefined> {
  const timeouts: Array<{ timeout: number }> = await k.raw('PRAGMA busy_timeout')
  const modes: Array<{ journal_mode: string }> = await k.raw('PRAGMA journal_mode')
  if (timeouts.length !== 1 || timeouts[0].timeout !== 0 || modes.length !== 1 || modes[0].journal_mode !== 'wal')
    return invalid()
  // Obtain the write reservation before any read can establish an old view.
  if (
    (await k('snapshot_journal_clock')
      .where('id', 1)
      .update({ revision: k.ref('revision') })) !== 1
  )
    return invalid()
  const before = await k('snapshot_journal_clock')
    .where('id', 1)
    .select(
      'enabled',
      { revision: snapshotJournalRevisionText(k, 'revision') },
      { ceiling: snapshotJournalRevisionText(k, 'ceiling') }
    )
    .first()
  if (!before || ![0, 1].includes(before.enabled)) return invalid()
  const revision = snapshotJournalRevision(before.revision),
    ceiling = snapshotJournalRevision(before.ceiling)
  if (ceiling === '0' || compareSnapshotJournalRevisions(revision, ceiling) > 0) return invalid()
  if (before.enabled === 0) return undefined
  await k.raw(SNAPSHOT_JOURNAL_SQLITE_ADVANCE)
  const after = await k('snapshot_journal_clock')
    .where('id', 1)
    .select('enabled', { revision: snapshotJournalRevisionText(k, 'revision') })
    .first()
  if (!after || ![0, 1].includes(after.enabled)) return invalid()
  const value = snapshotJournalRevision(after.revision)
  if (after.enabled === 0) return undefined
  if (BigInt(value) !== BigInt(revision) + 1n || compareSnapshotJournalRevisions(value, ceiling) > 0) return invalid()
  return value
}

async function mysqlFence(k: Knex): Promise<SnapshotJournalRevision | undefined> {
  const clock = await k('snapshot_journal_clock')
    .where('id', 1)
    .select({ ceiling: snapshotJournalRevisionText(k, 'ceiling') })
    .forUpdate()
    .noWait()
    .first()
  if (!clock) return invalid()
  const ceiling = snapshotJournalRevision(clock.ceiling)
  if (ceiling === '0') return invalid()
  // Current reads are required even if the caller earlier established an RR view.
  if (await k('snapshot_journal_invalid').where('id', 1).forUpdate().noWait().first('id')) return undefined
  await k('snapshot_journal_events').insert({})
  const [[allocated]]: Array<Array<{ revision: unknown }>> = await k.raw(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) revision'
  )
  if (typeof allocated?.revision !== 'string' || !/^[1-9]\d{0,19}$/.test(allocated.revision)) return invalid()
  const value = BigInt(allocated.revision)
  await k('snapshot_journal_events').where('revision', allocated.revision).delete()
  if (value > BigInt(ceiling)) {
    await k('snapshot_journal_invalid')
      .insert({
        id: 1,
        reason: value > BigInt(MAX_SNAPSHOT_JOURNAL_REVISION) ? 'revision-exhausted' : 'capacity-exhausted'
      })
      .onConflict('id')
      .ignore()
    return undefined
  }
  return snapshotJournalRevision(allocated.revision)
}

/** Internal primitive for an owned, validated, complete generation. The caller
 * must reserve both native connections before beginning this fresh transaction.
 * The exclusive barrier remains held until its transaction ends. Pin the separate
 * reader, record its receipt, and commit before publishing. Undefined means the
 * event window is disabled/exhausted: commit its invalidation without publishing.
 * This consumes one event position; it does not advance a retention floor.
 */
export async function reserveSnapshotJournalCaptureFence(k: Knex): Promise<SnapshotJournalRevision | undefined> {
  if (!k.isTransaction) return invalid()
  const client = k.client.config.client
  if (client === 'better-sqlite3' || client === 'sqlite3') return await sqliteFence(k)
  if (client === 'mysql' || client === 'mysql2') return await mysqlFence(k)
  return invalid()
}
