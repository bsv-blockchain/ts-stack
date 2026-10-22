import { brc38NativePackedObserverName, brc38NativePackedObserverNames } from './Brc38NativePackedObserverNames'
import { brc38NativePackedParentGuards } from './Brc38NativePackedParentGuards'
import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import {
  brc38NativeLocalPackedFamilyDefinitions,
  brc38NativeCompactPackedDefinitions,
  brc38NativeLocalJournalPayloadQuotaDefinitions
} from './Brc38NativeLocalPackedLayout'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import {
  hasBrc38NativePreparedFieldsSchema,
  brc38PreparedFieldVersionGuard
} from './Brc38NativePreparedFieldSchemaNode'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { requireBrc38NativeProfileTransaction, isBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import { runInSeries } from '../../utility/runInSeries'

export const brc38NativePackedMigration = '2026-09-29-001 private packed native binary fields'
export const nativePackedTables = Object.freeze({
  budget: 'brc38_native_binary_budget',
  versions: 'brc38_native_binary_versions',
  chunks: 'brc38_native_binary_chunks',
  fields: 'brc38_native_binary_fields',
  garbage: 'brc38_native_binary_garbage'
})
const definitions = [
  `CREATE TABLE brc38_native_binary_budget(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL CHECK(protocol='brc38-native-packed-fields/v1'),bindingSha256 TEXT NOT NULL CHECK(length(CAST(bindingSha256 AS BLOB))=64),maximumLogicalBytes INTEGER NOT NULL CHECK(typeof(maximumLogicalBytes)='integer' AND maximumLogicalBytes>0),reservedBytes INTEGER NOT NULL CHECK(typeof(reservedBytes)='integer' AND reservedBytes BETWEEN 0 AND maximumLogicalBytes))`,
  `CREATE TABLE brc38_native_binary_versions(sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 1000000000),accepted INTEGER NOT NULL CHECK(typeof(accepted)='integer' AND accepted BETWEEN 0 AND bytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks BETWEEN 0 AND 1000000000),state TEXT NOT NULL CHECK(state IN ('PENDING','SEALED','RETIRING')))`,
  `CREATE TABLE brc38_native_binary_chunks(sha256 TEXT NOT NULL REFERENCES brc38_native_binary_versions(sha256),offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset BETWEEN 0 AND 1000000000),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 65536),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),chunkSha256 TEXT NOT NULL CHECK(length(CAST(chunkSha256 AS BLOB))=64 AND chunkSha256 NOT GLOB '*[^0-9a-f]*'),PRIMARY KEY(sha256,offset))`,
  `CREATE TABLE brc38_native_binary_fields(tableId INTEGER NOT NULL CHECK(tableId BETWEEN 0 AND 4),rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer' AND rowId BETWEEN 1 AND 9007199254740991),fieldId INTEGER NOT NULL CHECK((tableId=0 AND fieldId BETWEEN 0 AND 2) OR (tableId IN (1,2) AND fieldId BETWEEN 0 AND 1) OR (tableId IN (3,4) AND fieldId=0)),sha256 TEXT NOT NULL REFERENCES brc38_native_binary_versions(sha256),PRIMARY KEY(tableId,rowId,fieldId))`,
  `CREATE INDEX brc38_native_binary_fields_version ON brc38_native_binary_fields(sha256)`,
  `CREATE TABLE brc38_native_binary_garbage(sha256 TEXT PRIMARY KEY NOT NULL REFERENCES brc38_native_binary_versions(sha256) ON DELETE CASCADE)`,
  `CREATE TRIGGER brc38_native_binary_garbage_insert_guard BEFORE INSERT ON brc38_native_binary_garbage BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM brc38_native_binary_fields WHERE sha256=NEW.sha256 LIMIT 1) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_versions WHERE sha256=NEW.sha256 AND state IN ('SEALED','RETIRING')) THEN RAISE(ABORT,'Packed native version is not collectible') END; END`,
  `CREATE TRIGGER brc38_native_binary_garbage_update_guard BEFORE UPDATE ON brc38_native_binary_garbage BEGIN SELECT RAISE(ABORT,'Packed native garbage identity is immutable'); END`,
  `CREATE TRIGGER brc38_native_binary_fields_insert_retain AFTER INSERT ON brc38_native_binary_fields BEGIN DELETE FROM brc38_native_binary_garbage WHERE sha256=NEW.sha256; END`,
  `CREATE TRIGGER brc38_native_binary_fields_delete_retire AFTER DELETE ON brc38_native_binary_fields WHEN NOT EXISTS(SELECT 1 FROM brc38_native_binary_fields WHERE sha256=OLD.sha256 LIMIT 1) BEGIN INSERT OR IGNORE INTO brc38_native_binary_garbage(sha256) VALUES(OLD.sha256); END`,
  `CREATE TRIGGER brc38_native_binary_budget_insert_guard BEFORE INSERT ON brc38_native_binary_budget WHEN NEW.reservedBytes!=0 BEGIN SELECT RAISE(ABORT,'Packed native initial budget differs'); END`,
  `CREATE TRIGGER brc38_native_binary_budget_update_guard BEFORE UPDATE ON brc38_native_binary_budget WHEN NEW.slot IS NOT OLD.slot OR NEW.protocol IS NOT OLD.protocol OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.maximumLogicalBytes IS NOT OLD.maximumLogicalBytes BEGIN SELECT RAISE(ABORT,'Packed native original budget is immutable'); END`,
  `CREATE TRIGGER brc38_native_binary_budget_delete_guard BEFORE DELETE ON brc38_native_binary_budget BEGIN SELECT RAISE(ABORT,'Packed native budget requires owned profile retirement'); END`,
  `CREATE TRIGGER brc38_native_binary_versions_insert_guard BEFORE INSERT ON brc38_native_binary_versions BEGIN SELECT CASE WHEN NEW.state!='PENDING' OR NEW.accepted!=0 OR NEW.chunks!=0 OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND NEW.bytes+512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native version reservation differs') END; END`,
  `CREATE TRIGGER brc38_native_binary_versions_insert_charge AFTER INSERT ON brc38_native_binary_versions BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+NEW.bytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_binary_versions_update_guard BEFORE UPDATE ON brc38_native_binary_versions BEGIN SELECT CASE WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.bytes IS NOT OLD.bytes OR NOT ((OLD.state='PENDING' AND NEW.state='PENDING' AND NEW.accepted>OLD.accepted AND NEW.chunks=OLD.chunks+1) OR (OLD.state='PENDING' AND NEW.state='SEALED' AND OLD.accepted=OLD.bytes AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks) OR (OLD.state='SEALED' AND NEW.state='RETIRING' AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks AND NOT EXISTS(SELECT 1 FROM brc38_native_binary_fields WHERE sha256=OLD.sha256 LIMIT 1)) OR (OLD.state='RETIRING' AND NEW.state='RETIRING' AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks-1)) THEN RAISE(ABORT,'Packed native version transition differs') END; END`,
  `CREATE TRIGGER brc38_native_binary_versions_delete_guard BEFORE DELETE ON brc38_native_binary_versions WHEN OLD.state!='RETIRING' OR OLD.chunks!=0 OR EXISTS(SELECT 1 FROM brc38_native_binary_fields WHERE sha256=OLD.sha256 LIMIT 1) OR EXISTS(SELECT 1 FROM brc38_native_binary_chunks WHERE sha256=OLD.sha256 LIMIT 1) BEGIN SELECT RAISE(ABORT,'Packed native version is still retained'); END`,
  `CREATE TRIGGER brc38_native_binary_versions_delete_charge AFTER DELETE ON brc38_native_binary_versions BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-OLD.bytes-512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_binary_chunks_insert_guard BEFORE INSERT ON brc38_native_binary_chunks BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM brc38_native_binary_versions WHERE sha256=NEW.sha256 AND state='PENDING' AND accepted=NEW.offset AND NEW.bytes<=bytes-accepted) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native chunk prefix or quota differs') END; END`,
  `CREATE TRIGGER brc38_native_binary_chunks_insert_charge AFTER INSERT ON brc38_native_binary_chunks BEGIN UPDATE brc38_native_binary_versions SET accepted=accepted+NEW.bytes,chunks=chunks+1 WHERE sha256=NEW.sha256; UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_binary_chunks_update_guard BEFORE UPDATE ON brc38_native_binary_chunks BEGIN SELECT RAISE(ABORT,'Packed native chunk postimages are immutable'); END`,
  `CREATE TRIGGER brc38_native_binary_chunks_delete_guard BEFORE DELETE ON brc38_native_binary_chunks WHEN NOT EXISTS(SELECT 1 FROM brc38_native_binary_versions WHERE sha256=OLD.sha256 AND state='RETIRING' AND NOT EXISTS(SELECT 1 FROM brc38_native_binary_fields WHERE sha256=OLD.sha256 LIMIT 1)) BEGIN SELECT RAISE(ABORT,'Packed native chunks are still retained'); END`,
  `CREATE TRIGGER brc38_native_binary_chunks_delete_charge AFTER DELETE ON brc38_native_binary_chunks BEGIN UPDATE brc38_native_binary_versions SET chunks=chunks-1 WHERE sha256=OLD.sha256; UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_binary_fields_insert_guard BEFORE INSERT ON brc38_native_binary_fields BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM brc38_native_binary_versions WHERE sha256=NEW.sha256 AND state='SEALED' AND accepted=bytes) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native field version or quota differs') END; END`,
  `CREATE TRIGGER brc38_native_binary_fields_insert_charge AFTER INSERT ON brc38_native_binary_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_binary_fields_update_guard BEFORE UPDATE ON brc38_native_binary_fields WHEN NEW.tableId IS NOT OLD.tableId OR NEW.fieldId IS NOT OLD.fieldId OR NEW.sha256 IS NOT OLD.sha256 OR NEW.rowId IS OLD.rowId BEGIN SELECT RAISE(ABORT,'Packed native field replacement requires atomic delete/insert'); END`,
  `CREATE TRIGGER brc38_native_binary_fields_delete_charge AFTER DELETE ON brc38_native_binary_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-512 WHERE slot=1; END`
]
const sources = Object.freeze([
  ['transactions', 'transactionId', ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']],
  ['proven_txs', 'provenTxId', ['rawTx', 'merklePath']],
  ['proven_tx_reqs', 'provenTxReqId', ['rawTx', 'inputBEEF']],
  ['outputs', 'outputId', ['lockingScript']],
  ['commissions', 'commissionId', ['lockingScript']]
] as const)
for (const [tableId, [table, key, binaries]] of sources.entries()) {
  const condition = binaries
    .map((field, fieldId) => `(NEW.fieldId=${fieldId} AND typeof(w.${field})='blob' AND length(w.${field})=0)`)
    .join(' OR ')
  definitions.push(
    `CREATE TRIGGER brc38_native_binary_fields_row_${tableId} BEFORE INSERT ON brc38_native_binary_fields WHEN NEW.tableId=${tableId} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${condition})) THEN RAISE(ABORT,'Packed native field has no actual metadata row') END; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_binary_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM brc38_native_binary_fields WHERE tableId=${tableId} AND rowId=OLD.${key}; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_binary_fields_move_${tableId} BEFORE UPDATE ON brc38_native_binary_fields WHEN NEW.tableId=${tableId} BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=OLD.rowId) OR NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${condition})) THEN RAISE(ABORT,'Packed native field move has no actual metadata key transition') END; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_binary_${table}_move AFTER UPDATE OF ${key} ON ${table} WHEN NEW.${key} IS NOT OLD.${key} BEGIN UPDATE brc38_native_binary_fields SET rowId=NEW.${key} WHERE tableId=${tableId} AND rowId=OLD.${key}; END`
  )
  for (const [fieldId, field] of binaries.entries()) {
    definitions.push(
      `CREATE TRIGGER brc38_native_binary_${table}_${field}_insert BEFORE INSERT ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='blob' OR length(NEW.${field})!=0) BEGIN SELECT RAISE(ABORT,'Packed native payload requires its bounded field writer'); END`
    )
    definitions.push(
      `CREATE TRIGGER brc38_native_binary_${table}_${field}_update BEFORE UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='blob' OR length(NEW.${field})!=0) BEGIN SELECT RAISE(ABORT,'Packed native payload requires its bounded field writer'); END`
    )
    definitions.push(
      `CREATE TRIGGER brc38_native_binary_${table}_${field}_clear AFTER UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NULL BEGIN DELETE FROM brc38_native_binary_fields WHERE tableId=${tableId} AND rowId=NEW.${key} AND fieldId=${fieldId}; END`
    )
  }
}
export const brc38NativePackedBinaryBaseDefinitions: readonly string[] = Object.freeze(definitions)
const compactDefinitions = brc38NativeCompactPackedDefinitions('binary', definitions)
const literalDefinitions = brc38NativeCompactPackedDefinitions('binary', definitions, true)
const groupedDefinitions = brc38NativePackedParentGuards('binary', literalDefinitions)
const namedDefinitions = brc38NativePackedObserverNames('binary', groupedDefinitions)
/** Inspect complete actual version-table SQL afresh; this chooses schema DATA,
 * never grants source admission. Mixed or altered families fail the subsequent
 * complete object and primary-index validation. An absent fresh family uses
 * the compact definition, while existing exact legacy tables stay legacy. */
export async function brc38NativePackedBinarySourceDefinitions(trx: Knex.Transaction): Promise<readonly string[]> {
  requireBrc38PackedRead(trx)
  const name = 'brc38_native_binary_versions',
    original = definitions.find(sql => sql.startsWith(`CREATE TABLE ${name}(`))!,
    actual = (await trx('sqlite_schema').where({ name, type: 'table' }).first('sql')) as { sql: unknown } | undefined
  if (actual === undefined) return literalDefinitions
  if (actual.sql === original + ' WITHOUT ROWID') {
    // The identical physical table can own either complete guard family.
    // Inspect the actual source trigger on each call; subsequent validation
    // compares every definition, refusing mixed/partial/tampered families.
    const probe = 'brc38_native_binary_fields_row_0',
      actualGuard = (await trx('main.sqlite_schema').where({ name: probe, type: 'trigger' }).first('sql')) as
        { sql: unknown } | undefined,
      guard = (selected: readonly string[]): string | undefined =>
        selected.find(sql => sql.startsWith(`CREATE TRIGGER ${probe} `))
    if (actualGuard?.sql === guard(literalDefinitions)) return literalDefinitions
    if (actualGuard?.sql === guard(compactDefinitions)) return compactDefinitions
    const local = await hasBrc38NativeLocalPackedLayout(trx),
      expanded = local
        ? brc38NativeCompactPackedDefinitions(
            'binary',
            brc38NativeLocalPackedFamilyDefinitions('binary', literalDefinitions),
            true
          )
        : literalDefinitions,
      grouped = brc38NativePackedParentGuards('binary', expanded)
    if (actualGuard?.sql === guard(grouped)) {
      const prefix = 'brc38_native_binary_',
        parents = [
          ...new Set(grouped.flatMap(sql => [...sql.matchAll(/FROM ([A-Za-z0-9_]+) w /g)].map(match => match[1])))
        ],
        placeholders = parents.map(() => '?').join(',')
      const shadows = await trx('sqlite_temp_schema')
        .where(query => {
          void query
            .whereRaw('lower(substr(name,1,?))=?', [prefix.length, prefix])
            .orWhereRaw(`lower(name) IN (${placeholders})`, parents)
            .orWhereRaw(`lower(tbl_name) IN (${placeholders})`, parents)
        })
        .select('name')
        .limit(1)
      if (shadows.length !== 0) throw new Error('Packed native parent temporary shadow differs')
      requireBrc38PackedRead(trx)
      const originalName = 'brc38_native_binary_garbage_insert_guard',
        compactName = brc38NativePackedObserverName('binary', originalName),
        anchors = (await trx('main.sqlite_schema')
          .where({ type: 'trigger' })
          .whereIn('name', [originalName, compactName])
          .select('name', 'sql')
          .limit(3)) as Array<{ name: string; sql: unknown }>
      if (anchors.length !== 1) throw new Error('Packed native observer name source differs')
      const selected = anchors[0].name === compactName ? brc38NativePackedObserverNames('binary', grouped) : grouped,
        expected = selected.find(sql => sql.startsWith(`CREATE TRIGGER ${anchors[0].name} `))
      if (anchors[0].sql !== expected) throw new Error('Packed native observer name source differs')
      return anchors[0].name === compactName ? namedDefinitions : groupedDefinitions
    }
    throw new Error('Packed native marker source differs')
  }
  if (actual.sql === original) return definitions
  throw new Error('Packed native version table source differs')
}
/** Select only definition DATA from this genuine view. Full family checks
 * below still reject partial, mixed and altered guard sets. Both historical
 * and projected families retain the same persisted tables and protocol. */
async function projectedPayloadQuota(trx: Knex.Transaction): Promise<boolean> {
  requireBrc38PackedRead(trx)
  const name = 'brc38_native_binary_journal_quota_14_insert',
    row = (await trx('main.sqlite_schema').where({ type: 'trigger', name }).first('sql')) as
      { sql: unknown } | undefined
  for (const projected of [false, true]) {
    const sql = brc38NativeLocalJournalPayloadQuotaDefinitions(projected).find(value =>
      value.startsWith(`CREATE TRIGGER ${name} `)
    )
    if (typeof row?.sql === 'string' && row.sql === sql) return projected
  }
  throw new Error('Packed native local payload quota source differs')
}
function expectedDefinitions(local: boolean, base: readonly string[], projected = false) {
  const grouped = base === groupedDefinitions || base === namedDefinitions,
    original = grouped ? literalDefinitions : base,
    expanded = local ? brc38NativeLocalPackedFamilyDefinitions('binary', original, projected) : original,
    compact =
      original !== definitions
        ? brc38NativeCompactPackedDefinitions('binary', expanded, original === literalDefinitions)
        : expanded,
    parents = grouped ? brc38NativePackedParentGuards('binary', compact) : compact,
    selected = base === namedDefinitions ? brc38NativePackedObserverNames('binary', parents) : parents
  return new Map(
    selected.map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
      return [match[2], { type: match[1].toLowerCase(), sql }]
    })
  )
}
/** Select the complete expected family DATA from this actual retained view.
 * Consumers must still validate the complete family before accepting extras;
 * this selector does not grant source admission or cache a capability verdict. */
export async function brc38NativePackedBinaryLayoutDefinitions(
  trx: Knex.Transaction
): Promise<ReadonlyMap<string, Readonly<{ type: string; sql: string }>>> {
  requireBrc38PackedRead(trx)
  const local = await hasBrc38NativeLocalPackedLayout(trx),
    base = await brc38NativePackedBinarySourceDefinitions(trx),
    expected = expectedDefinitions(local, base, local ? await projectedPayloadQuota(trx) : false)
  if (await hasBrc38NativePreparedFieldsSchema(trx)) {
    const name = 'brc38_native_binary_versions_update_guard',
      source = expected.get(name)!
    expected.set(name, { ...source, sql: brc38PreparedFieldVersionGuard('binary', source.sql) })
  }
  return expected
}
export function requireBrc38PackedRead(trx: Knex.Transaction): void {
  if (
    !isBrc38OwnedPrivateNativeSqlite(trx) &&
    !isBrc38PublishedCopyInspection(trx) &&
    !Brc38RetiredNativeReadNode.isReadTransaction(trx)
  )
    requireBrc38NativeProfileTransaction(trx)
  if (trx.isTransaction !== true) throw new Error('Packed native fields require their actual retained transaction')
}
export function requireBrc38PackedWriter(trx: Knex.Transaction): void {
  requireBrc38PackedRead(trx)
  if (Brc38RetiredNativeReadNode.isReadTransaction(trx))
    throw new Error('Retired source inspection cannot write packed content')
  if (isBrc38PublishedCopyInspection(trx)) throw new Error('Published copy inspection cannot write packed content')
  if (!isBrc38OwnedPrivateNativeWriter(trx)) {
    const driver = require('./NativeProfileSqlite.cjs') as {
      nativeTransactionIdentity: (value: Knex.Transaction) => { slot: number } | undefined
    }
    if (driver.nativeTransactionIdentity(trx)?.slot !== 0)
      throw new Error('Packed native fields require the actual wallet writer')
  }
}
/** Compare fresh source definitions inside SQLite, returning one scalar per
 * bounded batch. Never retain a verdict or fetch the complete SQL inventory.
 * A long original definition keeps its individual query; batches add at most
 * 32 definitions and 32KiB of bindings. Callers independently validate their
 * complete family count, layout, primary indexes and actual source authority. */
export async function verifyBrc38NativePackedDefinitions(
  trx: Knex.Transaction,
  expected: ReadonlyMap<string, Readonly<{ type: string; sql: string }>>
): Promise<void> {
  let batch: Array<Readonly<{ name: string; type: string; sql: string }>> = [],
    bytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    requireBrc38PackedRead(trx)
    const bindings: string[] = []
    const conditions = batch
      .map(source => {
        bindings.push(source.name, source.type, source.sql)
        return '(?,?,CAST(? AS BLOB))'
      })
      .join(',')
    const current = (await trx('sqlite_schema')
      .whereRaw('(name,type,CAST(sql AS BLOB)) IN (' + conditions + ')', bindings)
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (current?.count !== batch.length) throw new Error('Packed native source-owned schema differs')
    requireBrc38PackedRead(trx)
    batch = []
    bytes = 0
  }
  for (const [name, source] of expected) {
    const amount = Buffer.byteLength(name) + Buffer.byteLength(source.type) + Buffer.byteLength(source.sql)
    if (batch.length !== 0 && (batch.length >= 32 || amount > 32768 - bytes)) await flush()
    batch.push({ name, type: source.type, sql: source.sql })
    bytes += amount
    if (amount > 32768) await flush()
  }
  await flush()
}
/** Actual exact schema on every call; an absent family selects the original
 * legacy layout, while a partial/changed family always refuses. No verdict is
 * cached and these helpers grant no current source/profile/primary admission. */
export async function inspectBrc38NativePackedSchema(
  trx: Knex.Transaction
): Promise<Readonly<{ packed: boolean; prepared: boolean }>> {
  requireBrc38PackedRead(trx)
  const local = await hasBrc38NativeLocalPackedLayout(trx),
    base = await brc38NativePackedBinarySourceDefinitions(trx),
    expected = expectedDefinitions(local, base, local ? await projectedPayloadQuota(trx) : false)
  const total = (await trx('sqlite_schema')
    .whereRaw('substr(name,1,20)=?', ['brc38_native_binary_'])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) {
    if (local) throw new Error('Local packed mandatory family is absent')
    return Object.freeze({ packed: false, prepared: false })
  }
  if (total?.count !== expected.size) throw new Error('Packed native source-owned schema differs')
  const prepared = await hasBrc38NativePreparedFieldsSchema(trx)
  if (prepared) {
    const name = 'brc38_native_binary_versions_update_guard',
      source = expected.get(name)!
    expected.set(name, { ...source, sql: brc38PreparedFieldVersionGuard('binary', source.sql) })
  }
  await verifyBrc38NativePackedDefinitions(trx, expected)
  const indexes = (await trx('sqlite_schema')
    .whereIn('tbl_name', Object.values(nativePackedTables))
    .where({ type: 'index' })
    .whereNull('sql')
    .select('name')
    .limit(5)) as Array<{ name: string }>
  const primaryIndexes = [
    nativePackedTables.versions,
    nativePackedTables.chunks,
    nativePackedTables.fields,
    nativePackedTables.garbage
  ]
    .filter(table => base === definitions || table.endsWith('_chunks'))
    .map(table => `sqlite_autoindex_${table}_1`)
  if (indexes.length !== primaryIndexes.length || indexes.some(row => !primaryIndexes.includes(row.name)))
    throw new Error('Packed native primary-key schema differs')
  requireBrc38PackedRead(trx)
  return Object.freeze({ packed: true, prepared })
}
/** Fresh binary-family admission. The composed TEXT validator inspects this
 * same operation's prepared-family result directly; no saved or caller-supplied
 * verdict can authorize either entry point. */
export async function hasBrc38NativePackedSchema(trx: Knex.Transaction): Promise<boolean> {
  return (await inspectBrc38NativePackedSchema(trx)).packed
}
/** Fresh private schema only. The fixed logical reservation is taken from the
 * actual authenticated source binding; the native VFS independently enforces
 * the original physical main/journal/aggregate allowance. */
export async function installBrc38NativePackedSchema(trx: Knex.Transaction): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(trx)) throw new Error('An actual fresh private packed writer is required')
  if (await hasBrc38NativePackedSchema(trx)) throw new Error('Packed native migration is already installed')
  const binding = (await trx('private_binding')
    .where({ slot: 1 })
    .first(
      'digest',
      trx.raw('CASE WHEN length(CAST(limitsJson AS BLOB))<=256 THEN limitsJson ELSE NULL END AS limitsJson')
    )) as { digest: string; limitsJson: string } | undefined
  if (typeof binding?.limitsJson !== 'string' || !/^[0-9a-f]{64}$/.test(binding.digest))
    throw new Error('Packed native original source limits differ')
  const limits = JSON.parse(binding.limitsJson) as number[]
  if (limits.length !== 6 || !Number.isSafeInteger(limits[1]) || limits[1] < 1)
    throw new Error('Packed native original logical allowance differs')
  for (const [table] of sources)
    if (Number(((await trx(table).count({ count: '*' }).first()) as { count: number }).count) !== 0)
      throw new Error('Packed native installation requires an empty candidate')
  await runInSeries(literalDefinitions, async sql => await trx.raw(sql))
  await trx(nativePackedTables.budget).insert({
    slot: 1,
    protocol: 'brc38-native-packed-fields/v1',
    bindingSha256: binding.digest,
    maximumLogicalBytes: limits[1],
    reservedBytes: 0
  })
  if (!(await hasBrc38NativePackedSchema(trx)))
    throw new Error('Packed native installation did not persist its exact schema')
}
