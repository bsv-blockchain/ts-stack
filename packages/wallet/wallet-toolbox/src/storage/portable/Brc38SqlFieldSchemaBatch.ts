import type { Knex } from 'knex'
import { brc38SourceSealFieldDefinitions } from './Brc38AuthenticatedSourceSealNode'
import { brc38SqlStructuredPrefixDefinitions, type Brc38StructuredPrefixFamily } from './Brc38SqlStructuredPrefixGuards'

interface Definition {
  readonly name: string
  readonly table: string
  readonly sql: string
}
interface SchemaCounts {
  readonly total: number
  readonly baseMatches: number
  readonly prefixMatches: number
  readonly sealCount: number
  readonly sealMatches: number
}
export interface Brc38SqliteDefinitionBatch {
  readonly definitions: readonly Readonly<{ name: string; type: string; sql: string | null }>[]
  readonly tableNames?: readonly string[]
}

/** Fixed expected SQL DATA, never an owner or schema-admission token. Keep each
 * dispatch within the existing 32-definition/32-KiB binding envelope. A single
 * longer original definition retains its original individual query. */
export function* brc38SqliteDefinitionBatches(
  expected: ReadonlyMap<string, Readonly<{ type: string; sql: string | null }>>,
  tableNames?: readonly string[]
): Generator<Brc38SqliteDefinitionBatch> {
  const encoder = new TextEncoder(),
    tables = tableNames === undefined ? undefined : Object.freeze([...tableNames]),
    tableBytes = tables?.reduce((total, name) => total + encoder.encode(name).byteLength, 0) ?? 0
  let definitions: Array<Readonly<{ name: string; type: string; sql: string | null }>> = [],
    bytes = tableBytes
  for (const [name, source] of expected) {
    const amount =
      encoder.encode(name).byteLength +
      encoder.encode(source.type).byteLength +
      (source.sql === null ? 0 : encoder.encode(source.sql).byteLength)
    if (definitions.length !== 0 && (definitions.length >= 32 || amount > 32768 - bytes)) {
      yield Object.freeze({ definitions: Object.freeze(definitions), tableNames: tables })
      definitions = []
      bytes = tableBytes
    }
    definitions.push(Object.freeze({ name, type: source.type, sql: source.sql }))
    bytes += amount
    if (bytes > 32768) {
      yield Object.freeze({ definitions: Object.freeze(definitions), tableNames: tables })
      definitions = []
      bytes = tableBytes
    }
  }
  if (definitions.length !== 0) yield Object.freeze({ definitions: Object.freeze(definitions), tableNames: tables })
}

/** Fresh scalar comparisons only. Callers retain their original actual-owner,
 * complete-family, layout, index and error checks. No verdict is cached. */
export async function readBrc38SqliteDefinitionBatch(
  k: Knex,
  batch: Brc38SqliteDefinitionBatch,
  catalog: 'sqlite_schema' | 'main.sqlite_schema' = 'sqlite_schema'
): Promise<Readonly<{ matches: unknown; names: unknown }>> {
  if (
    (catalog !== 'sqlite_schema' && catalog !== 'main.sqlite_schema') ||
    batch.definitions.length < 1 ||
    batch.definitions.length > 32
  )
    throw new Error('Bounded SQLite definition comparison DATA required')
  if (batch.definitions.length === 1) {
    const source = batch.definitions[0],
      query = k(catalog).where({ name: source.name, type: source.type })
    if (batch.tableNames !== undefined) query.whereIn('tbl_name', batch.tableNames)
    if (source.sql === null) query.whereNull('sql')
    else query.whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [source.sql])
    const row = (await query.count({ count: '*' }).first()) as { count: unknown } | undefined
    // One exact name needs exactly one row; retain the original long-query
    // spelling and frame size, including its NULL implicit-index comparison.
    return Object.freeze({ matches: row?.count, names: row?.count })
  }
  const bindings: string[] = []
  const conditions = batch.definitions
    .filter(source => source.sql !== null)
    .map(source => {
      bindings.push(source.name, source.type, source.sql!)
      return '(?,?,CAST(? AS BLOB))'
    })
    .join(',')
  const nullDefinitions = batch.definitions.filter(source => source.sql === null),
    nullConditions = nullDefinitions
      .map(source => {
        bindings.push(source.name, source.type)
        return '(?,?)'
      })
      .join(','),
    predicates = [
      ...(conditions === '' ? [] : ['(name,type,CAST(sql AS BLOB)) IN (' + conditions + ')']),
      ...(nullConditions === '' ? [] : ['(sql IS NULL AND (name,type) IN (' + nullConditions + '))'])
    ]
  const query = k(catalog).whereRaw('(' + predicates.join(' OR ') + ')', bindings)
  if (batch.tableNames !== undefined) query.whereIn('tbl_name', batch.tableNames)
  const row = (await query.count({ matches: '*' }).countDistinct({ names: 'name' }).first()) as
    { matches: unknown; names: unknown } | undefined
  return Object.freeze({ matches: row?.matches, names: row?.names })
}
function exact(definitions: readonly Definition[], bindings: Array<string | number>): string {
  return definitions
    .map(value => {
      bindings.push(value.name, value.table, value.sql)
      return "(type='trigger' AND name=? AND tbl_name=? AND CAST(sql AS BLOB)=CAST(? AS BLOB))"
    })
    .join(' OR ')
}
/** Fresh bounded scalar comparison DATA from the original SQLite view. Every
 * table, primary index, immutable-prefix trigger and optional authenticated seal
 * is compared together. No DDL payload or reusable verdict crosses the boundary;
 * callers retain ownership, absence, completeness and original error checks. */
export async function readBrc38SqlFieldSchemaCounts(
  k: Knex,
  family: Brc38StructuredPrefixFamily,
  tables: readonly (readonly [string, string])[]
): Promise<SchemaCounts> {
  if (tables.length !== 2) throw new Error('Private field comparison requires its two original tables')
  const bindings: Array<string | number> = []
  const tableMatches = tables.map(([name, sql]) => {
    bindings.push(name, name, sql)
    return "(type='table' AND name=? AND tbl_name=? AND CAST(sql AS BLOB)=CAST(? AS BLOB))"
  })
  bindings.push(...tables.map(([name]) => `sqlite_autoindex_${name}_1`))
  const base = [...tableMatches, "(type='index' AND sql IS NULL AND name IN (?,?))"].join(' OR ')
  const prefixes = exact(brc38SqlStructuredPrefixDefinitions(family), bindings)
  const sealPrefix = 'brc38_source_seal_'
  bindings.push(sealPrefix.length, sealPrefix)
  const seals = exact(brc38SourceSealFieldDefinitions(family), bindings)
  const result = (await k('sqlite_schema')
    .whereIn(
      'tbl_name',
      tables.map(([name]) => name)
    )
    .select(
      k.raw(
        `count(*) AS total,
      sum(CASE WHEN ${base} THEN 1 ELSE 0 END) AS baseMatches,
      sum(CASE WHEN ${prefixes} THEN 1 ELSE 0 END) AS prefixMatches,
      sum(CASE WHEN type='trigger' AND substr(name,1,?)=? THEN 1 ELSE 0 END) AS sealCount,
      sum(CASE WHEN ${seals} THEN 1 ELSE 0 END) AS sealMatches`,
        bindings
      )
    )
    .first()) as SchemaCounts | undefined
  if (result === undefined) throw new Error('Private field schema comparison is unavailable')
  return result
}
