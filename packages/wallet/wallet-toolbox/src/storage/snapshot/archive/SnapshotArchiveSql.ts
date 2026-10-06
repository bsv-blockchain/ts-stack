import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

export interface SnapshotArchiveCapacity {
  archives: number
  reservedBytes: number | string
}

export async function snapshotArchiveDatabaseNow(k: Knex): Promise<number> {
  if (String(k.client.config.client).includes('mysql')) {
    const [rows]: Array<Array<{ now: number | string }>> = await k.raw(
      'SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now'
    )
    return Number(rows[0].now)
  }
  const rows: Array<{ now: number }> = await k.raw(
    "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now"
  )
  return rows[0].now
}

export async function lockSnapshotArchiveCapacity(k: Knex): Promise<SnapshotArchiveCapacity> {
  // SQLite reserves the writer; MySQL locks the shared auxiliary capacity row.
  await k('snapshot_archive_capacity').where({ id: 1 }).update({ id: 1 })
  const row: SnapshotArchiveCapacity | undefined = await k('snapshot_archive_capacity').where({ id: 1 }).first()
  if (row === undefined) throw new WERR_INVALID_OPERATION('Snapshot archive schema is unavailable')
  return row
}
