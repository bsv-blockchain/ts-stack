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

export const nativeSnapshotJournalMappingMigration = '2026-10-17-001 private native journal mapping fence'
const journalClock = 'brc38_journal_mapping_clock'
const journalPrefix = 'brc38_journal_mapping_'
/** Authored auxiliary DDL is comparison DATA, not a native connection grant.
 * Watches actual parent associations and sealed identity/frame DATA, including
 * direct SQL changes. It does not add financial events or copy feedback. */
export const nativeSnapshotJournalMappingDdl: readonly string[] = Object.freeze([
  `CREATE TABLE ${journalClock}(id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775807))`,
  ...[
    { table: 'snapshot_reconciliation_identity_maps', suffix: 'parents', parents: true },
    { table: 'snapshot_reconciliation_captured_identities', suffix: 'captured', parents: false },
    { table: 'snapshot_reconciliation_identity_frames', suffix: 'frames', parents: false }
  ].flatMap(owner =>
    (['INSERT', 'UPDATE', 'DELETE'] as const).map(event => {
      const relevant = owner.parents
        ? ` WHEN ${event === 'INSERT' ? 'NEW.tableId IN(0,8)' : event === 'DELETE' ? 'OLD.tableId IN(0,8)' : '(OLD.tableId IN(0,8) OR NEW.tableId IN(0,8))'}`
        : ''
      return `CREATE TRIGGER ${journalPrefix}${owner.suffix}_${event.toLowerCase()} BEFORE ${event} ON ${owner.table}${relevant} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${journalClock} WHERE id=1 AND typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775806) THEN RAISE(ABORT,'Native journal mapping fence exhausted or absent') END; UPDATE ${journalClock} SET revision=revision+1 WHERE id=1; END`
    })
  )
])
/** Optional family inspection for the original destination schema verifier.
 * Absence preserves old profiles; any partial/extra/changed family refuses.
 * Definitions are freshly compared inside the actual view on every call. */
export async function nativeSnapshotJournalMappingDefinitions(trx: Knex.Transaction): Promise<readonly string[]> {
  requireBrc38PackedRead(trx)
  const objects = (await trx('sqlite_schema')
    .where(function () {
      void this.whereRaw('substr(name,1,?)=?', [journalPrefix.length, journalPrefix]).orWhere('tbl_name', journalClock)
    })
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (objects?.count === 0) return Object.freeze([])
  if (objects?.count !== nativeSnapshotJournalMappingDdl.length) invalid()
  for (const sql of nativeSnapshotJournalMappingDdl) {
    const match = /^CREATE (TABLE|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
    const actual = (await trx('sqlite_schema')
      .where({ name: match[2], type: match[1].toLowerCase() })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (actual?.count !== 1) invalid()
  }
  requireBrc38PackedRead(trx)
  return nativeSnapshotJournalMappingDdl
}
export async function readNativeSnapshotJournalMappingRevision(trx: Knex.Transaction): Promise<string> {
  if ((await nativeSnapshotJournalMappingDefinitions(trx)).length === 0) invalid()
  const rows: Array<{ revision: unknown }> = await trx(journalClock)
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
export async function installNativeSnapshotJournalMappingSchema(trx: Knex.Transaction): Promise<void> {
  requireBrc38PackedWriter(trx)
  if (!isBrc38OwnedPrivateNativeWriter(trx)) invalid()
  for (const sql of nativeSnapshotJournalMappingDdl) await trx.raw(sql)
  await trx(journalClock).insert({ id: 1, revision: 0 })
  await readNativeSnapshotJournalMappingRevision(trx)
}
