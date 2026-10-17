import type { Knex } from 'knex'
import {
  requireBrc38PackedRead,
  requireBrc38PackedWriter,
  hasBrc38NativePackedSchema
} from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38SqliteDefinitionBatches, readBrc38SqliteDefinitionBatch } from './Brc38SqlFieldSchemaBatch'

export const nativePreparedFieldsTable = 'brc38_native_prepared_fields'
export const brc38NativePreparedFieldsMigration = '2026-10-07-003 private native prepared field lifetimes'
export type Brc38NativePreparedFamily = 'binary' | 'text'
const families = ['binary', 'text'] as const
const definitions = [
  `CREATE TABLE brc38_native_prepared_fields(id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(id AS BLOB))=32 AND id NOT GLOB '*[^0-9a-f]*'),family TEXT NOT NULL CHECK(family IN ('binary','text')),sha256 TEXT NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),expiresAt INTEGER NOT NULL CHECK(typeof(expiresAt)='integer' AND expiresAt BETWEEN 1 AND 9007199254740991))`,
  `CREATE INDEX brc38_native_prepared_fields_version ON brc38_native_prepared_fields(family,sha256)`,
  `CREATE INDEX brc38_native_prepared_fields_expiry ON brc38_native_prepared_fields(expiresAt,id)`,
  `CREATE TRIGGER brc38_native_prepared_fields_update_guard BEFORE UPDATE ON brc38_native_prepared_fields BEGIN SELECT RAISE(ABORT,'Native field preparation cannot renew or change identity'); END`,
  `CREATE TRIGGER brc38_native_prepared_fields_insert_charge AFTER INSERT ON brc38_native_prepared_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes+512 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_native_prepared_fields_delete_charge AFTER DELETE ON brc38_native_prepared_fields BEGIN UPDATE brc38_native_binary_budget SET reservedBytes=reservedBytes-512 WHERE slot=1; END`
]
for (const family of families) {
  const prefix = 'brc38_native_' + family,
    refs = `${prefix}_fields`,
    versions = `${prefix}_versions`,
    garbage = `${prefix}_garbage`,
    held = `EXISTS(SELECT 1 FROM brc38_native_prepared_fields WHERE family='${family}' AND sha256=OLD.sha256 LIMIT 1)`,
    heldNew = `EXISTS(SELECT 1 FROM brc38_native_prepared_fields WHERE family='${family}' AND sha256=NEW.sha256 LIMIT 1)`
  definitions.push(
    `CREATE TRIGGER brc38_native_prepared_${family}_insert_guard BEFORE INSERT ON brc38_native_prepared_fields WHEN NEW.family='${family}' BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${versions} WHERE sha256=NEW.sha256 AND state IN ('PENDING','SEALED')) OR NOT EXISTS(SELECT 1 FROM brc38_native_binary_budget WHERE slot=1 AND 512<=maximumLogicalBytes-reservedBytes) THEN RAISE(ABORT,'Native field preparation differs from actual content or original quota') END; END`,
    `CREATE TRIGGER brc38_native_prepared_${family}_insert_retain AFTER INSERT ON brc38_native_prepared_fields WHEN NEW.family='${family}' BEGIN DELETE FROM ${garbage} WHERE sha256=NEW.sha256; END`,
    `CREATE TRIGGER brc38_native_prepared_${family}_garbage_guard BEFORE INSERT ON ${garbage} WHEN ${heldNew} BEGIN SELECT RAISE(IGNORE); END`,
    `CREATE TRIGGER brc38_native_prepared_${family}_retirement_guard BEFORE UPDATE OF state ON ${versions} WHEN NEW.state='RETIRING' AND OLD.state!='RETIRING' AND ${held} BEGIN SELECT RAISE(ABORT,'Native field preparation still retains its content'); END`,
    `CREATE TRIGGER brc38_native_prepared_${family}_delete_guard BEFORE DELETE ON ${versions} WHEN ${held} BEGIN SELECT RAISE(ABORT,'Native field preparation still retains its content'); END`,
    `CREATE TRIGGER brc38_native_prepared_${family}_delete_retire AFTER DELETE ON brc38_native_prepared_fields WHEN OLD.family='${family}' AND NOT EXISTS(SELECT 1 FROM ${refs} WHERE sha256=OLD.sha256 LIMIT 1) AND NOT ${held} BEGIN UPDATE ${versions} SET state='RETIRING' WHERE sha256=OLD.sha256 AND state='PENDING'; INSERT OR IGNORE INTO ${garbage}(sha256) SELECT sha256 FROM ${versions} WHERE sha256=OLD.sha256 AND state IN ('SEALED','RETIRING'); END`
  )
}
const compactDefinitions = definitions.map(sql =>
  sql.startsWith(`CREATE TABLE ${nativePreparedFieldsTable}(`) ? sql + ' WITHOUT ROWID' : sql
)
function expectedDefinitions(compact: boolean) {
  return new Map(
    (compact ? compactDefinitions : definitions).map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
      return [match[2], { type: match[1].toLowerCase(), sql }]
    })
  )
}
function invalid(): never {
  throw new Error('Native prepared field schema or original lifetime differs')
}
/** An explicit additive source-owned schema variant permits abandonment of a
 * partial PENDING prefix only after ALL actual preparation and row references
 * are absent. The original transition rules otherwise remain byte-for-byte.
 * This function describes DDL DATA; it does not verify or authorize anything. */
export function brc38PreparedFieldVersionGuard(family: Brc38NativePreparedFamily, original: string): string {
  const prefix = 'brc38_native_' + family,
    marker = `(OLD.state='RETIRING' AND NEW.state='RETIRING'`,
    cancellation = `(OLD.state='PENDING' AND NEW.state='RETIRING' AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks AND NOT EXISTS(SELECT 1 FROM ${prefix}_fields WHERE sha256=OLD.sha256 LIMIT 1) AND NOT EXISTS(SELECT 1 FROM brc38_native_prepared_fields WHERE family='${family}' AND sha256=OLD.sha256 LIMIT 1)) OR `
  if (
    !families.includes(family) ||
    !original.startsWith(`CREATE TRIGGER ${prefix}_versions_update_guard `) ||
    original.split(marker).length !== 2
  )
    invalid()
  return original.replace(marker, cancellation + marker)
}
/** Complete fresh comparison, never a saved schema verdict. Optional absence
 * preserves the original packed layout; partial/changed definitions refuse. */
export async function hasBrc38NativePreparedFieldsSchema(k: Knex.Transaction): Promise<boolean> {
  requireBrc38PackedRead(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,22)=?', ['brc38_native_prepared_'])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) return false
  const actualTable = (await k('sqlite_schema')
      .where({ name: nativePreparedFieldsTable, type: 'table' })
      .first('sql')) as { sql: unknown } | undefined,
    compact = actualTable?.sql === compactDefinitions[0]
  if (!compact && actualTable?.sql !== definitions[0]) invalid()
  const expected = expectedDefinitions(compact)
  if (total?.count !== expected.size) invalid()
  for (const batch of brc38SqliteDefinitionBatches(expected)) {
    requireBrc38PackedRead(k)
    const actual = await readBrc38SqliteDefinitionBatch(k, batch)
    if (actual.matches !== batch.definitions.length || actual.names !== batch.definitions.length) invalid()
  }
  const primary = (await k('sqlite_schema')
    .where({ tbl_name: nativePreparedFieldsTable, type: 'index' })
    .whereNull('sql')
    .select('name')
    .limit(2)) as Array<{ name: string }>
  if (
    compact
      ? primary.length !== 0
      : primary.length !== 1 || primary[0].name !== `sqlite_autoindex_${nativePreparedFieldsTable}_1`
  )
    invalid()
  requireBrc38PackedRead(k)
  return true
}
/** Fresh empty authenticated candidate only, within its source-owned migration
 * BEFORE generation/seal receipts. No existing live profile migration or
 * activation is inferred. Original binary/TEXT budgets and limits stay fixed. */
export async function installBrc38NativePreparedFieldsSchema(k: Knex.Transaction): Promise<void> {
  requireBrc38PackedWriter(k)
  if (
    !isBrc38OwnedPrivateNativeWriter(k) ||
    (await hasBrc38NativePreparedFieldsSchema(k)) ||
    !(await hasBrc38NativePackedSchema(k)) ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
  for (const family of families) {
    const prefix = 'brc38_native_' + family
    if (
      (await k(`${prefix}_versions`).first('sha256')) !== undefined ||
      (await k(`${prefix}_fields`).first('sha256')) !== undefined
    )
      invalid()
  }
  await k.raw('SAVEPOINT brc38_native_prepared_schema')
  try {
    for (const sql of compactDefinitions) await k.raw(sql)
    for (const family of families) {
      const name = 'brc38_native_' + family + '_versions_update_guard',
        value = (await k('sqlite_schema').where({ name, type: 'trigger' }).first('sql')) as { sql: string } | undefined
      if (typeof value?.sql !== 'string') invalid()
      const replacement = brc38PreparedFieldVersionGuard(family, value.sql)
      await k.raw('DROP TRIGGER ??', [name])
      await k.raw(replacement)
    }
    if (
      !(await hasBrc38NativePreparedFieldsSchema(k)) ||
      !(await hasBrc38NativePackedSchema(k)) ||
      !(await hasBrc38NativePackedTextSchema(k))
    )
      invalid()
    await k.raw('RELEASE brc38_native_prepared_schema')
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO brc38_native_prepared_schema')
      await k.raw('RELEASE brc38_native_prepared_schema')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Native preparation schema retains failed rollback', { cause })
    }
    throw cause
  }
}
