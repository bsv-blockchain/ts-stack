import type { Knex } from 'knex'

interface SchemaColumn {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
  hidden: number
}
interface SchemaIndex {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}
export interface SqliteSchemaObservation {
  table: string
  columns: SchemaColumn[]
  indexes: SchemaIndex[]
}

/** Fresh metadata within the caller's pinned SQLite transaction only. Outside
 * that transaction, preserve the original sequential individual reads. */
export async function readSqliteSchemaObservations(
  k: Knex,
  names: string[]
): Promise<SqliteSchemaObservation[] | undefined> {
  const tables = [...names]
  if (
    !k.isTransaction ||
    k.client.config.client !== 'better-sqlite3' ||
    tables.length === 0 ||
    tables.length > 16 ||
    !tables.every(table => typeof table === 'string' && /^[a-z_][a-z0-9_]*$/i.test(table))
  )
    return undefined
  const selected = tables.map((_, index) => `SELECT ${index} ordinal, ? name`).join(' UNION ALL ')
  const columns: Array<SchemaColumn & { sourceOrdinal: string }> = await k.raw(
    `SELECT CAST(s.ordinal AS TEXT) sourceOrdinal,p.* FROM (${selected}) s CROSS JOIN pragma_table_xinfo(s.name) p ORDER BY s.ordinal,p.cid`,
    tables
  )
  const indexes: Array<SchemaIndex & { sourceOrdinal: string }> = await k.raw(
    `SELECT CAST(s.ordinal AS TEXT) sourceOrdinal,p.* FROM (${selected}) s CROSS JOIN pragma_index_list(s.name) p ORDER BY s.ordinal,p.seq`,
    tables
  )
  const observed: SqliteSchemaObservation[] = tables.map(table => ({ table, columns: [], indexes: [] }))
  const byOrdinal = new Map(observed.map((value, index) => [String(index), value]))
  for (const { sourceOrdinal, ...column } of columns) byOrdinal.get(sourceOrdinal)?.columns.push(column)
  for (const { sourceOrdinal, ...index } of indexes) byOrdinal.get(sourceOrdinal)?.indexes.push(index)
  return observed
}
