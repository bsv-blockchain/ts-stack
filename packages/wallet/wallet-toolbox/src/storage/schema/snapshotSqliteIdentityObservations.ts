import type { Knex } from 'knex'

interface IdentityColumn {
  name: string
  type: string
  pk: number
  hidden: number
}
interface IdentityIndex {
  name: string
  unique: number
  partial: number
}
export interface SqliteIdentityObservation {
  table: string
  columns: IdentityColumn[]
  indexes: IdentityIndex[]
}

/** Two fresh bounded SQLite statements. These rows never outlive one identity
 * construction. Preserve original PRAGMA metadata fields and ordering. */
export async function readSqliteIdentityObservations(
  k: Knex,
  sourceTables: string[]
): Promise<SqliteIdentityObservation[] | undefined> {
  const tables = [...sourceTables]
  if (
    k.client.config.client !== 'better-sqlite3' ||
    tables.length === 0 ||
    tables.length > 16 ||
    !tables.every(table => typeof table === 'string' && /^[a-z_][a-z0-9_]*$/i.test(table))
  )
    return undefined
  const selected = tables.map((_, index) => `SELECT ${index} ordinal, ? name`).join(' UNION ALL ')
  const columns: Array<IdentityColumn & { sourceOrdinal: string }> = await k.raw(
    `SELECT CAST(s.ordinal AS TEXT) sourceOrdinal,p.* FROM (${selected}) s CROSS JOIN pragma_table_xinfo(s.name) p ORDER BY s.ordinal,p.cid`,
    tables
  )
  const indexes: Array<IdentityIndex & { sourceOrdinal: string }> = await k.raw(
    `SELECT CAST(s.ordinal AS TEXT) sourceOrdinal,p.* FROM (${selected}) s CROSS JOIN pragma_index_list(s.name) p ORDER BY s.ordinal,p.seq`,
    tables
  )
  const observed: SqliteIdentityObservation[] = tables.map(table => ({ table, columns: [], indexes: [] }))
  const byOrdinal = new Map(observed.map((value, index) => [String(index), value]))
  for (const { sourceOrdinal, ...column } of columns) byOrdinal.get(sourceOrdinal)?.columns.push(column)
  for (const { sourceOrdinal, ...index } of indexes) byOrdinal.get(sourceOrdinal)?.indexes.push(index)
  return observed
}
