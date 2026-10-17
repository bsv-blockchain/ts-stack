import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { isBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import { runInSeries } from '../../utility/runInSeries'
import { brc38NativePriorImportTables } from './Brc38NativePriorImportTables'
import { brc38SqliteDefinitionBatches, readBrc38SqliteDefinitionBatch } from './Brc38SqlFieldSchemaBatch'

const journalSql = `CREATE TABLE brc38_import_journal (
  importId TEXT NOT NULL PRIMARY KEY,
  bindingSha256 TEXT NOT NULL CHECK(typeof(bindingSha256) = 'text' AND length(bindingSha256) = 64),
  archiveSha256 TEXT NOT NULL CHECK(typeof(archiveSha256) = 'text' AND length(archiveSha256) = 64),
  userId INTEGER NOT NULL CHECK(typeof(userId) = 'integer' AND userId BETWEEN -9007199254740991 AND 9007199254740991),
  mappedIds INTEGER NOT NULL DEFAULT 0 CHECK(typeof(mappedIds) = 'integer' AND mappedIds BETWEEN 0 AND 1000000000),
  maximumMappedIds INTEGER NOT NULL CHECK(typeof(maximumMappedIds) = 'integer' AND maximumMappedIds BETWEEN 0 AND 1000000000 AND mappedIds <= maximumMappedIds),
  cleanupAllowed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cleanupAllowed) = 'integer' AND cleanupAllowed IN (0, 1)),
  admissionJson TEXT NOT NULL CHECK(typeof(admissionJson) = 'text' AND length(CAST(admissionJson AS BLOB)) BETWEEN 1 AND 4096),
  admissionSha256 TEXT NOT NULL CHECK(typeof(admissionSha256) = 'text' AND length(admissionSha256) = 64),
  receiptJson TEXT NOT NULL CHECK(typeof(receiptJson) = 'text' AND length(CAST(receiptJson AS BLOB)) BETWEEN 1 AND 4096),
  receiptSha256 TEXT NOT NULL CHECK(typeof(receiptSha256) = 'text' AND length(receiptSha256) = 64)
)`

const mappingSql = `CREATE TABLE brc38_import_ids (
  importId TEXT NOT NULL REFERENCES brc38_import_journal(importId),
  bindingSha256 TEXT NOT NULL CHECK(typeof(bindingSha256) = 'text' AND length(bindingSha256) = 64),
  archiveSha256 TEXT NOT NULL CHECK(typeof(archiveSha256) = 'text' AND length(archiveSha256) = 64),
  userId INTEGER NOT NULL CHECK(typeof(userId) = 'integer' AND userId BETWEEN -9007199254740991 AND 9007199254740991),
  entity TEXT NOT NULL CHECK(typeof(entity) = 'text' AND length(CAST(entity AS BLOB)) BETWEEN 1 AND 32),
  incomingId TEXT NOT NULL CHECK(typeof(incomingId) = 'text' AND length(CAST(incomingId AS BLOB)) BETWEEN 1 AND 32),
  localId INTEGER NOT NULL CHECK(typeof(localId) = 'integer' AND localId BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY(importId, bindingSha256, archiveSha256, userId, entity, incomingId)
)`

const mappingGuardSql = `CREATE TRIGGER brc38_import_ids_insert_guard BEFORE INSERT ON brc38_import_ids BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM brc38_import_journal WHERE importId = NEW.importId
    AND bindingSha256 = NEW.bindingSha256 AND archiveSha256 = NEW.archiveSha256 AND userId = NEW.userId
    AND cleanupAllowed = 0 AND mappedIds < maximumMappedIds)
    THEN RAISE(ABORT, 'Private import mapping scope or quota differs') END;
END`

const mappingChargeSql = `CREATE TRIGGER brc38_import_ids_insert_charge AFTER INSERT ON brc38_import_ids BEGIN
  UPDATE brc38_import_journal SET mappedIds = mappedIds + 1 WHERE importId = NEW.importId;
END`

const mappingImmutableSql = `CREATE TRIGGER brc38_import_ids_update_guard BEFORE UPDATE ON brc38_import_ids BEGIN
  SELECT RAISE(ABORT, 'Private import mappings are immutable');
END`

const mappingDeleteGuardSql = `CREATE TRIGGER brc38_import_ids_delete_guard BEFORE DELETE ON brc38_import_ids BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM brc38_import_journal WHERE importId = OLD.importId AND cleanupAllowed = 1)
    THEN RAISE(ABORT, 'Private import mappings require owned cleanup') END;
END`

const mappingDeleteChargeSql = `CREATE TRIGGER brc38_import_ids_delete_charge AFTER DELETE ON brc38_import_ids BEGIN
  UPDATE brc38_import_journal SET mappedIds = mappedIds - 1 WHERE importId = OLD.importId;
END`

const triggers = [mappingGuardSql, mappingChargeSql, mappingImmutableSql, mappingDeleteGuardSql, mappingDeleteChargeSql]

const expectedObjects = new Map<string, { type: string; sql: string | null }>([
  ['brc38_import_journal', { type: 'table', sql: journalSql }],
  ['brc38_import_ids', { type: 'table', sql: mappingSql }],
  ['sqlite_autoindex_brc38_import_journal_1', { type: 'index', sql: null }],
  ['sqlite_autoindex_brc38_import_ids_1', { type: 'index', sql: null }],
  ...triggers.map(sql => [sql.split(' ')[2], { type: 'trigger', sql }] as const)
])

/** Select from fresh actual metadata, never a persisted backend verdict. Only
 * genuine native metadata tables use clustered primary trees, including their
 * unchanged occupied family in an actual read-only published copy. Raw provenance
 * payload tables remain rowid tables for the incremental BLOB protocol. An
 * occupied family must be complete and exact before install can reuse it. */
export async function readBrc38ImportSchemaFamily(
  k: Knex.Transaction,
  legacy: ReadonlyMap<string, { type: string; sql: string | null }>,
  compactTables: readonly string[],
  error: string,
  fresh = false
): Promise<ReadonlyMap<string, { type: string; sql: string | null }>> {
  const differs = (): never => {
    throw new Error(error)
  }
  const tables = [...legacy].filter(([, value]) => value.type === 'table').map(([name]) => name)
  const temporary = await k('sqlite_temp_schema')
    .whereIn('tbl_name', tables)
    .orWhereIn('name', [...legacy.keys()])
    .count({ count: '*' })
    .first()
  if (temporary?.count !== 0) differs()
  const total = await k('main.sqlite_schema').whereIn('tbl_name', tables).count({ count: '*' }).first()
  const native = isOwnedNativeSqlite(k),
    copy = isBrc38PublishedCopyInspection(k)
  // Prior-import custody preserves the original physical row identity. A
  // clustered metadata tree has no rowid and cannot supply that key. Fresh
  // unpublished families therefore retain rowid tables instead of requiring
  // another surrogate-key protocol just to save an index. Existing layouts
  // below are still selected only from their exact actual definitions.
  const requiresPhysicalRowIds = compactTables.some(table =>
    brc38NativePriorImportTables.some(prior => prior === table)
  )
  let compact = native && !requiresPhysicalRowIds
  if (total?.count !== 0) {
    const anchor = compactTables[0],
      definition = legacy.get(anchor)
    if (definition?.type !== 'table' || typeof definition.sql !== 'string') differs()
    const matches = async (sql: string) =>
      (
        await k('main.sqlite_schema')
          .where({ name: anchor, type: 'table', tbl_name: anchor })
          .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
          .count({ count: '*' })
          .first()
      )?.count === 1
    if (await matches(definition!.sql!)) compact = false
    else if ((native || copy) && (await matches(definition!.sql! + ' WITHOUT ROWID'))) compact = true
    else differs()
  } else if (!fresh) differs()
  const selected = new Map(
    [...legacy]
      .filter(([name]) => !compact || !compactTables.some(table => name === `sqlite_autoindex_${table}_1`))
      .map(
        ([name, value]) =>
          [
            name,
            {
              ...value,
              sql: compact && compactTables.includes(name) ? value.sql + ' WITHOUT ROWID' : value.sql
            }
          ] as const
      )
  )
  if (total?.count === 0 && fresh) return selected
  if (total?.count !== selected.size) differs()
  for (const batch of brc38SqliteDefinitionBatches(selected, tables)) {
    const actual = await readBrc38SqliteDefinitionBatch(k, batch, 'main.sqlite_schema')
    if (actual.matches !== batch.definitions.length || actual.names !== batch.definitions.length) differs()
  }
  if (isOwnedNativeSqlite(k) !== native || isBrc38PublishedCopyInspection(k) !== copy) differs()
  return selected
}
const compactTables = ['brc38_import_journal', 'brc38_import_ids']
const schemaError = 'Private import journal schema differs from its owned source'
export async function installBrc38ImportJournalSchema(k: Knex.Transaction): Promise<void> {
  const selected = await readBrc38ImportSchemaFamily(k, expectedObjects, compactTables, schemaError, true)
  await runInSeries(selected.values(), async value => {
    if (value.sql !== null)
      await k.raw(
        value.sql
          .replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
          .replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')
      )
  })
  await verifyBrc38ImportJournalSchema(k)
}
export async function verifyBrc38ImportJournalSchema(k: Knex.Transaction): Promise<void> {
  await readBrc38ImportSchemaFamily(k, expectedObjects, compactTables, schemaError)
}
