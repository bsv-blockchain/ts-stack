import type { Knex } from 'knex'
import { requireBrc38PackedRead, requireBrc38PackedWriter } from '../portable/Brc38NativePackedSchemaNode'
import { isBrc38OwnedPrivateNativeWriter } from '../portable/KnexBrc38StagingStore'
import { snapshotJournalRevision } from './journal/SnapshotJournalRevision'

export const nativeSnapshotSyncMappingMigration = '2026-10-07-004 private native sync mapping fence'
const table = 'brc38_native_sync_mapping_clock'
const definitions = Object.freeze([
  `CREATE TABLE ${table}(id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775807))`,
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map(
    event =>
      `CREATE TRIGGER brc38_native_sync_mapping_${event.toLowerCase()} BEFORE ${event} ON snapshot_sync_ids BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE id=1 AND typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775806) THEN RAISE(ABORT,'Native snapshot mapping fence exhausted or absent') END; UPDATE ${table} SET revision=revision+1 WHERE id=1; END`
  )
])
function invalid(): never {
  throw new Error('Native snapshot current mapping schema or revision differs')
}
/** Registered additive private-native migration. The database observes every
 * actual mapping insert/update/delete, including independent writers. The
 * counter is comparison DATA only; current mapped parents/session ownership
 * must still be read on the original actual transaction. */
export async function installNativeSnapshotSyncMappingSchema(trx: Knex.Transaction): Promise<void> {
  requireBrc38PackedWriter(trx)
  if (!isBrc38OwnedPrivateNativeWriter(trx) || !(await trx.schema.hasTable('snapshot_sync_ids'))) invalid()
  for (const sql of definitions) await trx.raw(sql)
  await trx(table).insert({ id: 1, revision: 0 })
  await readNativeSnapshotSyncMappingRevision(trx)
}
export async function readNativeSnapshotSyncMappingRevision(trx: Knex.Transaction): Promise<string> {
  requireBrc38PackedRead(trx)
  const count = (await trx('sqlite_schema')
    .whereRaw('substr(name,1,18)=?', ['brc38_native_sync_'])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (count?.count !== definitions.length) invalid()
  for (const sql of definitions) {
    const match = /^CREATE (TABLE|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
    const actual = (await trx('sqlite_schema')
      .where({ name: match[2], type: match[1].toLowerCase() })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (actual?.count !== 1) invalid()
  }
  const rows: Array<{ revision: unknown }> = await trx(table)
    .where({ id: 1 })
    .select(
      trx.raw(
        "CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775807 THEN CAST(revision AS TEXT) END AS revision"
      )
    )
    .limit(2)
  if (rows.length !== 1) invalid()
  requireBrc38PackedRead(trx)
  return snapshotJournalRevision(rows[0].revision)
}
