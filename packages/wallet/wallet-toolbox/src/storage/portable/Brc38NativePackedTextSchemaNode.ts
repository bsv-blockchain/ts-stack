import { brc38NativePackedObserverName, brc38NativePackedObserverNames } from './Brc38NativePackedObserverNames'
import { brc38NativePackedParentGuards } from './Brc38NativePackedParentGuards'
import {
  brc38NativeLocalPackedFamilyDefinitions,
  brc38NativeCompactPackedDefinitions
} from './Brc38NativeLocalPackedLayout'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { brc38PreparedFieldVersionGuard } from './Brc38NativePreparedFieldSchemaNode'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import {
  inspectBrc38NativePackedSchema,
  requireBrc38PackedRead,
  verifyBrc38NativePackedDefinitions
} from './Brc38NativePackedSchemaNode'
import { runInSeries } from '../../utility/runInSeries'

export const brc38NativePackedTextMigration = '2026-10-07-001 private packed native structured text fields'
export const nativePackedTextTables = Object.freeze({
  budget: 'brc38_native_binary_budget',
  versions: 'brc38_native_text_versions',
  chunks: 'brc38_native_text_chunks',
  fields: 'brc38_native_text_fields',
  garbage: 'brc38_native_text_garbage',
  progress: 'brc38_native_text_gc_progress'
})
const definitions = [
  `CREATE TABLE brc38_native_text_gc_progress(slot INTEGER PRIMARY KEY CHECK(slot=1),nextFamily INTEGER NOT NULL CHECK(typeof(nextFamily)='integer' AND nextFamily IN (0,1)))`,
  `CREATE TRIGGER brc38_native_text_gc_progress_insert_guard BEFORE INSERT ON brc38_native_text_gc_progress BEGIN SELECT CASE WHEN NEW.nextFamily!=0 OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native original collection reservation differs') END; END`,
  `CREATE TRIGGER brc38_native_text_gc_progress_insert_charge AFTER INSERT ON brc38_native_text_gc_progress BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_gc_progress_update_guard BEFORE UPDATE ON brc38_native_text_gc_progress WHEN NEW.slot IS NOT OLD.slot OR NEW.nextFamily=OLD.nextFamily BEGIN SELECT RAISE(ABORT,'Packed native collection progress must alternate'); END`,
  `CREATE TRIGGER brc38_native_text_gc_progress_delete_guard BEFORE DELETE ON brc38_native_text_gc_progress BEGIN SELECT RAISE(ABORT,'Packed native collection progress requires owned profile retirement'); END`,
  `CREATE TABLE brc38_native_text_versions(sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 1000000000),accepted INTEGER NOT NULL CHECK(typeof(accepted)='integer' AND accepted BETWEEN 0 AND bytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks BETWEEN 0 AND 1000000000),state TEXT NOT NULL CHECK(state IN ('PENDING','SEALED','RETIRING')))`,
  `CREATE TABLE brc38_native_text_chunks(sha256 TEXT NOT NULL REFERENCES brc38_native_text_versions(sha256),offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset BETWEEN 0 AND 1000000000),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 65536),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),chunkSha256 TEXT NOT NULL CHECK(length(CAST(chunkSha256 AS BLOB))=64 AND chunkSha256 NOT GLOB '*[^0-9a-f]*'),PRIMARY KEY(sha256,offset))`,
  `CREATE TABLE brc38_native_text_fields(tableId INTEGER NOT NULL CHECK(tableId IN (0,2,3,4,5,6,7)),rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer' AND rowId BETWEEN -9007199254740991 AND 9007199254740991),fieldId INTEGER NOT NULL CHECK((tableId=0 AND fieldId BETWEEN 3 AND 5) OR (tableId=2 AND fieldId BETWEEN 2 AND 3) OR (tableId=3 AND fieldId BETWEEN 1 AND 7) OR (tableId=4 AND fieldId=1) OR (tableId=5 AND fieldId BETWEEN 0 AND 2) OR (tableId=6 AND fieldId BETWEEN 0 AND 3) OR (tableId=7 AND fieldId BETWEEN 0 AND 1)),sha256 TEXT NOT NULL REFERENCES brc38_native_text_versions(sha256),PRIMARY KEY(tableId,rowId,fieldId))`,
  `CREATE INDEX brc38_native_text_fields_version ON brc38_native_text_fields(sha256)`,
  `CREATE TABLE brc38_native_text_garbage(sha256 TEXT PRIMARY KEY NOT NULL REFERENCES brc38_native_text_versions(sha256) ON DELETE CASCADE)`,
  `CREATE TRIGGER brc38_native_text_garbage_insert_guard BEFORE INSERT ON brc38_native_text_garbage BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM brc38_native_text_fields WHERE sha256=NEW.sha256 LIMIT 1) OR NOT EXISTS(SELECT 1 FROM brc38_native_text_versions WHERE sha256=NEW.sha256 AND state IN ('SEALED','RETIRING')) THEN RAISE(ABORT,'Packed native version is not collectible') END; END`,
  `CREATE TRIGGER brc38_native_text_garbage_update_guard BEFORE UPDATE ON brc38_native_text_garbage BEGIN SELECT RAISE(ABORT,'Packed native garbage identity is immutable'); END`,
  `CREATE TRIGGER brc38_native_text_fields_insert_retain AFTER INSERT ON brc38_native_text_fields BEGIN DELETE FROM brc38_native_text_garbage WHERE sha256=NEW.sha256; END`,
  `CREATE TRIGGER brc38_native_text_fields_delete_retire AFTER DELETE ON brc38_native_text_fields WHEN NOT EXISTS(SELECT 1 FROM brc38_native_text_fields WHERE sha256=OLD.sha256 LIMIT 1) BEGIN INSERT OR IGNORE INTO brc38_native_text_garbage(sha256) VALUES(OLD.sha256); END`,
  `CREATE TRIGGER brc38_native_text_versions_insert_guard BEFORE INSERT ON brc38_native_text_versions BEGIN SELECT CASE WHEN NEW.state!='PENDING' OR NEW.accepted!=0 OR NEW.chunks!=0 OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND NEW.bytes+512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native version reservation differs') END; END`,
  `CREATE TRIGGER brc38_native_text_versions_insert_charge AFTER INSERT ON brc38_native_text_versions BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+NEW.bytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_versions_update_guard BEFORE UPDATE ON brc38_native_text_versions BEGIN SELECT CASE WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.bytes IS NOT OLD.bytes OR NOT ((OLD.state='PENDING' AND NEW.state='PENDING' AND NEW.accepted>OLD.accepted AND NEW.chunks=OLD.chunks+1) OR (OLD.state='PENDING' AND NEW.state='SEALED' AND OLD.accepted=OLD.bytes AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks) OR (OLD.state='SEALED' AND NEW.state='RETIRING' AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks AND NOT EXISTS(SELECT 1 FROM brc38_native_text_fields WHERE sha256=OLD.sha256 LIMIT 1)) OR (OLD.state='RETIRING' AND NEW.state='RETIRING' AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks-1)) THEN RAISE(ABORT,'Packed native version transition differs') END; END`,
  `CREATE TRIGGER brc38_native_text_versions_delete_guard BEFORE DELETE ON brc38_native_text_versions WHEN OLD.state!='RETIRING' OR OLD.chunks!=0 OR EXISTS(SELECT 1 FROM brc38_native_text_fields WHERE sha256=OLD.sha256 LIMIT 1) OR EXISTS(SELECT 1 FROM brc38_native_text_chunks WHERE sha256=OLD.sha256 LIMIT 1) BEGIN SELECT RAISE(ABORT,'Packed native version is still retained'); END`,
  `CREATE TRIGGER brc38_native_text_versions_delete_charge AFTER DELETE ON brc38_native_text_versions BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-OLD.bytes-512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_chunks_insert_guard BEFORE INSERT ON brc38_native_text_chunks BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM brc38_native_text_versions WHERE sha256=NEW.sha256 AND state='PENDING' AND accepted=NEW.offset AND NEW.bytes<=bytes-accepted) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native chunk prefix or quota differs') END; END`,
  `CREATE TRIGGER brc38_native_text_chunks_insert_charge AFTER INSERT ON brc38_native_text_chunks BEGIN UPDATE brc38_native_text_versions SET accepted=accepted+NEW.bytes,chunks=chunks+1 WHERE sha256=NEW.sha256; UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_chunks_update_guard BEFORE UPDATE ON brc38_native_text_chunks BEGIN SELECT RAISE(ABORT,'Packed native chunk postimages are immutable'); END`,
  `CREATE TRIGGER brc38_native_text_chunks_delete_guard BEFORE DELETE ON brc38_native_text_chunks WHEN NOT EXISTS(SELECT 1 FROM brc38_native_text_versions WHERE sha256=OLD.sha256 AND state='RETIRING' AND NOT EXISTS(SELECT 1 FROM brc38_native_text_fields WHERE sha256=OLD.sha256 LIMIT 1)) BEGIN SELECT RAISE(ABORT,'Packed native chunks are still retained'); END`,
  `CREATE TRIGGER brc38_native_text_chunks_delete_charge AFTER DELETE ON brc38_native_text_chunks BEGIN UPDATE brc38_native_text_versions SET chunks=chunks-1 WHERE sha256=OLD.sha256; UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_fields_insert_guard BEFORE INSERT ON brc38_native_text_fields BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM brc38_native_text_versions WHERE sha256=NEW.sha256 AND state='SEALED' AND accepted=bytes) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Packed native field version or quota differs') END; END`,
  `CREATE TRIGGER brc38_native_text_fields_insert_charge AFTER INSERT ON brc38_native_text_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_text_fields_update_guard BEFORE UPDATE ON brc38_native_text_fields WHEN NEW.tableId IS NOT OLD.tableId OR NEW.fieldId IS NOT OLD.fieldId OR NEW.sha256 IS NOT OLD.sha256 OR NEW.rowId IS OLD.rowId BEGIN SELECT RAISE(ABORT,'Packed native field replacement requires atomic delete/insert'); END`,
  `CREATE TRIGGER brc38_native_text_fields_delete_charge AFTER DELETE ON brc38_native_text_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-512 WHERE slot=1; END`
]
const sources = nativePackedTextSources.map(
  source =>
    [
      source.id,
      source.sql,
      source.key,
      source.fields.map((field, ordinal) => [source.first + ordinal, field] as const)
    ] as const
)
for (const [tableId, table, key, fields] of sources) {
  const condition = fields
    .map(
      ([fieldId, field]) =>
        `(NEW.fieldId=${fieldId} AND typeof(w.${field})='text' AND length(CAST(w.${field} AS BLOB))=0)`
    )
    .join(' OR ')
  definitions.push(
    `CREATE TRIGGER brc38_native_text_fields_row_${tableId} BEFORE INSERT ON brc38_native_text_fields WHEN NEW.tableId=${tableId} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${condition})) THEN RAISE(ABORT,'Packed native text field has no actual metadata row') END; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_text_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM brc38_native_text_fields WHERE tableId=${tableId} AND rowId=OLD.${key}; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_text_fields_move_${tableId} BEFORE UPDATE ON brc38_native_text_fields WHEN NEW.tableId=${tableId} BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=OLD.rowId) OR NOT EXISTS(SELECT 1 FROM ${table} w WHERE w.${key}=NEW.rowId AND (${condition})) THEN RAISE(ABORT,'Packed native text field move has no actual metadata key transition') END; END`
  )
  definitions.push(
    `CREATE TRIGGER brc38_native_text_${table}_move AFTER UPDATE OF ${key} ON ${table} WHEN NEW.${key} IS NOT OLD.${key} BEGIN UPDATE brc38_native_text_fields SET rowId=NEW.${key} WHERE tableId=${tableId} AND rowId=OLD.${key}; END`
  )
  for (const [fieldId, field] of fields) {
    definitions.push(
      `CREATE TRIGGER brc38_native_text_${table}_${field}_insert BEFORE INSERT ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='text' OR length(CAST(NEW.${field} AS BLOB))!=0) BEGIN SELECT RAISE(ABORT,'Packed native text requires its bounded field writer'); END`
    )
    definitions.push(
      `CREATE TRIGGER brc38_native_text_${table}_${field}_update BEFORE UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NOT NULL AND (typeof(NEW.${field})!='text' OR length(CAST(NEW.${field} AS BLOB))!=0) BEGIN SELECT RAISE(ABORT,'Packed native text requires its bounded field writer'); END`
    )
    definitions.push(
      `CREATE TRIGGER brc38_native_text_${table}_${field}_clear AFTER UPDATE OF ${field} ON ${table} WHEN NEW.${field} IS NULL BEGIN DELETE FROM brc38_native_text_fields WHERE tableId=${tableId} AND rowId=NEW.${key} AND fieldId=${fieldId}; END`
    )
  }
}
export const brc38NativePackedTextBaseDefinitions: readonly string[] = Object.freeze(definitions)
const compactDefinitions = brc38NativeCompactPackedDefinitions('text', definitions)
const literalDefinitions = brc38NativeCompactPackedDefinitions('text', definitions, true)
const groupedDefinitions = brc38NativePackedParentGuards('text', literalDefinitions)
const namedDefinitions = brc38NativePackedObserverNames('text', groupedDefinitions)
/** Inspect complete actual version-table SQL afresh; this chooses schema DATA,
 * never grants source admission. Mixed or altered families fail the subsequent
 * complete object and primary-index validation. An absent fresh family uses
 * the compact definition, while existing exact legacy tables stay legacy. */
export async function brc38NativePackedTextSourceDefinitions(trx: Knex.Transaction): Promise<readonly string[]> {
  requireBrc38PackedRead(trx)
  const name = 'brc38_native_text_versions',
    original = definitions.find(sql => sql.startsWith(`CREATE TABLE ${name}(`))!,
    actual = (await trx('sqlite_schema').where({ name, type: 'table' }).first('sql')) as { sql: unknown } | undefined
  if (actual === undefined) return literalDefinitions
  if (actual.sql === original + ' WITHOUT ROWID') {
    // The identical physical table can own either complete guard family.
    // Inspect the actual source trigger on each call; subsequent validation
    // compares every definition, refusing mixed/partial/tampered families.
    const probe = 'brc38_native_text_fields_row_0',
      actualGuard = (await trx('main.sqlite_schema').where({ name: probe, type: 'trigger' }).first('sql')) as
        { sql: unknown } | undefined,
      guard = (selected: readonly string[]): string | undefined =>
        selected.find(sql => sql.startsWith(`CREATE TRIGGER ${probe} `))
    if (actualGuard?.sql === guard(literalDefinitions)) return literalDefinitions
    if (actualGuard?.sql === guard(compactDefinitions)) return compactDefinitions
    const local = await hasBrc38NativeLocalPackedLayout(trx),
      expanded = local
        ? brc38NativeCompactPackedDefinitions(
            'text',
            brc38NativeLocalPackedFamilyDefinitions('text', literalDefinitions),
            true
          )
        : literalDefinitions,
      grouped = brc38NativePackedParentGuards('text', expanded)
    if (actualGuard?.sql === guard(grouped)) {
      const prefix = 'brc38_native_text_',
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
      const originalName = 'brc38_native_text_garbage_insert_guard',
        compactName = brc38NativePackedObserverName('text', originalName),
        anchors = (await trx('main.sqlite_schema')
          .where({ type: 'trigger' })
          .whereIn('name', [originalName, compactName])
          .select('name', 'sql')
          .limit(3)) as Array<{ name: string; sql: unknown }>
      if (anchors.length !== 1) throw new Error('Packed native observer name source differs')
      const selected = anchors[0].name === compactName ? brc38NativePackedObserverNames('text', grouped) : grouped,
        expected = selected.find(sql => sql.startsWith(`CREATE TRIGGER ${anchors[0].name} `))
      if (anchors[0].sql !== expected) throw new Error('Packed native observer name source differs')
      return anchors[0].name === compactName ? namedDefinitions : groupedDefinitions
    }
    throw new Error('Packed native marker source differs')
  }
  if (actual.sql === original) return definitions
  throw new Error('Packed native version table source differs')
}
function expectedDefinitions(local: boolean, base: readonly string[]) {
  const grouped = base === groupedDefinitions || base === namedDefinitions,
    original = grouped ? literalDefinitions : base,
    expanded = local ? brc38NativeLocalPackedFamilyDefinitions('text', original) : original,
    compact =
      original !== definitions
        ? brc38NativeCompactPackedDefinitions('text', expanded, original === literalDefinitions)
        : expanded,
    parents = grouped ? brc38NativePackedParentGuards('text', compact) : compact,
    selected = base === namedDefinitions ? brc38NativePackedObserverNames('text', parents) : parents
  return new Map(
    selected.map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
      return [match[2], { type: match[1].toLowerCase(), sql }]
    })
  )
}
/** Additive fresh TEXT family, sharing the original binary logical reservation. Actual exact schema on every call; an absent family selects the original
 * legacy layout, while a partial/changed family always refuses. No verdict is
 * cached and these helpers grant no current source/profile/primary admission. */
export async function hasBrc38NativePackedTextSchema(trx: Knex.Transaction): Promise<boolean> {
  requireBrc38PackedRead(trx)
  const local = await hasBrc38NativeLocalPackedLayout(trx),
    base = await brc38NativePackedTextSourceDefinitions(trx),
    expected = expectedDefinitions(local, base)
  const binary = await inspectBrc38NativePackedSchema(trx)
  const total = (await trx('sqlite_schema')
    .whereRaw('substr(name,1,18)=?', ['brc38_native_text_'])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) {
    if (local) throw new Error('Local packed mandatory family is absent')
    return false
  }
  if (!binary.packed) throw new Error('Packed text requires the actual original shared binary budget schema')
  if (total?.count !== expected.size) throw new Error('Packed native source-owned schema differs')
  // Binary inspection just validated every prepared definition in this actual
  // retained transaction. Reuse only that fresh composed result; do not repeat
  // the same complete prepared inventory within this operation.
  if (binary.prepared) {
    const name = 'brc38_native_text_versions_update_guard',
      source = expected.get(name)!
    expected.set(name, { ...source, sql: brc38PreparedFieldVersionGuard('text', source.sql) })
  }
  await verifyBrc38NativePackedDefinitions(trx, expected)
  const indexes = (await trx('sqlite_schema')
    .whereIn('tbl_name', [
      nativePackedTextTables.versions,
      nativePackedTextTables.chunks,
      nativePackedTextTables.fields,
      nativePackedTextTables.garbage
    ])
    .where({ type: 'index' })
    .whereNull('sql')
    .select('name')
    .limit(5)) as Array<{ name: string }>
  const primaryIndexes = [
    nativePackedTextTables.versions,
    nativePackedTextTables.chunks,
    nativePackedTextTables.fields,
    nativePackedTextTables.garbage
  ]
    .filter(table => base === definitions || table.endsWith('_chunks'))
    .map(table => `sqlite_autoindex_${table}_1`)
  if (indexes.length !== primaryIndexes.length || indexes.some(row => !primaryIndexes.includes(row.name)))
    throw new Error('Packed native primary-key schema differs')
  requireBrc38PackedRead(trx)
  return true
}
/** Fresh private schema only. The fixed logical reservation is taken from the
 * actual authenticated source binding; the native VFS independently enforces
 * the original physical main/journal/aggregate allowance. */
export async function installBrc38NativePackedTextSchema(trx: Knex.Transaction): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(trx)) throw new Error('An actual fresh private packed writer is required')
  if (await hasBrc38NativePackedTextSchema(trx)) throw new Error('Packed native migration is already installed')
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
  for (const [, table] of sources)
    if (Number(((await trx(table).count({ count: '*' }).first()) as { count: number }).count) !== 0)
      throw new Error('Packed native installation requires an empty candidate')
  await runInSeries(literalDefinitions, async sql => await trx.raw(sql))
  const actual = (await trx(nativePackedTextTables.budget)
    .where({ slot: 1 })
    .first('protocol', 'bindingSha256', 'maximumLogicalBytes')) as
    { protocol: string; bindingSha256: string; maximumLogicalBytes: number } | undefined
  if (
    actual?.protocol !== 'brc38-native-packed-fields/v1' ||
    actual.bindingSha256 !== binding.digest ||
    actual.maximumLogicalBytes !== limits[1]
  )
    throw new Error('Packed text original shared budget differs')
  await trx(nativePackedTextTables.progress).insert({ slot: 1, nextFamily: 0 })
  if (!(await hasBrc38NativePackedTextSchema(trx)))
    throw new Error('Packed native installation did not persist its exact schema')
}
