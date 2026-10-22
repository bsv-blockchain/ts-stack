import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { verifyBrc38SqlStructuredPrefixGuards } from './Brc38SqlStructuredPrefixGuards'

const prefix = 'brc38_source_seal_'
const immutable = ['rows', 'table_counts', 'unique_keys', 'memberships', 'private_binding'] as const
const binaries = ['private_binary_fields', 'private_binary_chunks'] as const
const structured = ['private_structured_fields', 'private_structured_chunks'] as const
const texts = ['private_text_fields', 'private_text_chunks'] as const
const canonicalStructured = ['private_canonical_structured_fields', 'private_canonical_structured_chunks'] as const
interface Definition {
  readonly name: string
  readonly table: string
  readonly sql: string
}
function refusal(table: string, operation: string): Definition {
  const name = `${prefix}${table}_${operation.toLowerCase()}`
  return {
    name,
    table,
    sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Authenticated private source is immutable'); END`
  }
}
function definitions(binary: boolean, json = false, canonical = false, text = false): Definition[] {
  const result: Definition[] = []
  for (const table of [
    ...immutable,
    ...(binary ? binaries : []),
    ...(json ? structured : []),
    ...(canonical ? canonicalStructured : []),
    ...(text ? texts : [])
  ])
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) result.push(refusal(table, operation))
  for (const table of ['metadata', 'private_import']) {
    result.push(refusal(table, 'INSERT'), refusal(table, 'DELETE'))
    const name = `${prefix}${table}_update`
    const condition =
      table === 'metadata'
        ? `NEW.slot IS NOT OLD.slot OR NEW.state IS NOT OLD.state OR NEW.rows IS NOT OLD.rows OR NEW.header IS NOT OLD.header OR typeof(NEW.logicalBytes)!='integer' OR NEW.logicalBytes<0 OR NEW.logicalBytes>json_extract((SELECT limitsJson FROM private_binding WHERE slot=1),'$[1]')`
        : `NEW.slot IS NOT OLD.slot OR NEW.archiveSha256 IS NOT OLD.archiveSha256 OR (NEW.previewJson IS NULL)!=(NEW.previewSha256 IS NULL) OR (NEW.previewJson IS NOT NULL AND (typeof(NEW.previewJson)!='text' OR length(CAST(NEW.previewJson AS BLOB))>8192 OR typeof(NEW.previewSha256)!='text' OR length(CAST(NEW.previewSha256 AS BLOB))!=64))`
    result.push({
      name,
      table,
      sql: `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} BEGIN SELECT CASE WHEN ${condition} THEN RAISE(ABORT, 'Authenticated private source seal or preview bound differs') END; END`
    })
  }
  return result
}
function invalid(): never {
  throw new Error('Authenticated private source write protection differs')
}
/** Compare the complete fixed family inside SQLite in one fresh statement.
 * Only the count crosses the boundary; no trigger SQL payloads or verdicts are
 * retained. Each unique expected name still requires exact type, table and SQL. */
async function verifyDefinitions(k: Knex, expected: readonly Definition[]): Promise<void> {
  const actual = (await k('sqlite_schema')
    .whereRaw(
      '(name,type,tbl_name,CAST(sql AS BLOB)) IN (' + expected.map(() => '(?,?,?,CAST(? AS BLOB))').join(',') + ')',
      expected.flatMap(value => [value.name, 'trigger', value.table, value.sql])
    )
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (actual?.count !== expected.length) invalid()
}
async function selected(k: Knex): Promise<Definition[]> {
  const rows: Array<{ name: string }> = await k('sqlite_schema')
    .where({ type: 'table' })
    .whereIn('name', [...binaries, ...structured, ...canonicalStructured, ...texts])
    .select('name')
    .limit(9)
  const family = (names: readonly string[]): boolean => {
    const count = rows.filter(row => names.includes(row.name)).length
    if (count !== 0 && (count !== 2 || !names.every(name => rows.some(row => row.name === name)))) invalid()
    return count === 2
  }
  const json = family(structured),
    canonical = family(canonicalStructured)
  if (canonical && !json) invalid()
  return definitions(family(binaries), json, canonical, family(texts))
}
/** Fixed expected SQL DATA only; actual installed schema is inspected on each
 * call. Legacy binary framing verification admits precisely these six guards,
 * never arbitrary extra triggers or a caller-supplied seal marker. */
export function isBrc38BinarySourceSealDefinition(row: { name: string; type: string; sql: string | null }): boolean {
  return (
    row.type === 'trigger' &&
    definitions(true).some(
      value => binaries.some(table => table === value.table) && row.name === value.name && row.sql === value.sql
    )
  )
}
export function isBrc38StructuredSourceSealDefinition(row: {
  name: string
  type: string
  sql: string | null
}): boolean {
  return (
    row.type === 'trigger' &&
    definitions(false, true).some(
      value => structured.some(table => table === value.table) && row.name === value.name && row.sql === value.sql
    )
  )
}
export function isBrc38CanonicalStructuredSourceSealDefinition(row: {
  name: string
  type: string
  sql: string | null
}): boolean {
  return (
    row.type === 'trigger' &&
    definitions(false, false, true).some(
      value =>
        canonicalStructured.some(table => table === value.table) && row.name === value.name && row.sql === value.sql
    )
  )
}
/** Expected fixed definition DATA only; each real view still requires fresh comparison. */
export function brc38SourceSealFieldDefinitions(
  family: 'binary' | 'structured' | 'canonical' | 'text'
): readonly Definition[] {
  const tables =
    family === 'binary'
      ? binaries
      : family === 'structured'
        ? structured
        : family === 'canonical'
          ? canonicalStructured
          : family === 'text'
            ? texts
            : undefined
  if (tables === undefined) invalid()
  return tables.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(operation => refusal(table, operation)))
}

/** Actual per-family source-owned guards, freshly compared inside SQLite.
 * A returned count is comparison DATA for this schema operation, not a reusable
 * seal/source admission. Omitted guards are allowed only before installation. */
export async function verifyBrc38SourceSealFieldDefinitions(
  k: Knex,
  family: 'binary' | 'structured' | 'canonical' | 'text'
): Promise<0 | 6> {
  const expected = brc38SourceSealFieldDefinitions(family),
    tables = [...new Set(expected.map(value => value.table))]
  const row = (await k('sqlite_schema')
    .where({ type: 'trigger' })
    .whereIn('tbl_name', tables)
    .whereRaw('substr(name,1,?)=?', [prefix.length, prefix])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (row?.count === 0) return 0
  if (row?.count !== 6) invalid()
  await verifyDefinitions(k, expected)
  return 6
}
export async function verifyBrc38AuthenticatedSourceSeal(k: Knex): Promise<void> {
  const expected = await selected(k),
    tables = [...immutable, ...binaries, ...structured, ...canonicalStructured, ...texts, 'metadata', 'private_import'],
    actual = (await k('sqlite_schema')
      .where({ type: 'trigger' })
      .whereIn('tbl_name', tables)
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
  let prefixes = 0
  if (expected.some(value => value.table === binaries[0]))
    prefixes += await verifyBrc38SqlStructuredPrefixGuards(k, 'binary')
  if (expected.some(value => value.table === structured[0]))
    prefixes += await verifyBrc38SqlStructuredPrefixGuards(k, 'structured')
  if (expected.some(value => value.table === canonicalStructured[0]))
    prefixes += await verifyBrc38SqlStructuredPrefixGuards(k, 'canonical')
  if (expected.some(value => value.table === texts[0]))
    prefixes += await verifyBrc38SqlStructuredPrefixGuards(k, 'text')
  if (actual?.count !== expected.length + prefixes) invalid()
  await verifyDefinitions(k, expected)
}
/** Installation belongs to the same transaction as successful whole-envelope
 * authentication, AFTER all source rows/fields/semantic closure have settled.
 * It cannot authorize an unauthenticated source or rewrite an older seal. */
export async function installBrc38AuthenticatedSourceSeal(trx: Knex.Transaction): Promise<void> {
  if (trx.isTransaction !== true) invalid()
  const expected = await selected(trx)
  await runInSeries(expected, async value => {
    await trx.raw(value.sql)
  })
  await verifyBrc38AuthenticatedSourceSeal(trx)
}
