import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { invalid, sources, type Table, type Index } from './snapshotGlobalIndexModel'
import { readSqliteSchemaObservations, type SqliteSchemaObservation } from './snapshotSqliteSchemaObservations'
import { readSqliteIndexObservations, type SqliteIndexObservation } from './snapshotSqliteIdentityObservations'
interface SqlitePart {
  name: string | null
  desc: number
  coll: string
  key: number
}
async function sqliteParts(k: Knex, name: string): Promise<SqlitePart[]> {
  const rows: SqlitePart[] = await k.raw('PRAGMA index_xinfo(??)', [name])
  return rows.filter(row => row.key === 1)
}
export async function sqliteTable(k: Knex, table: Table, secondary: boolean): Promise<boolean> {
  return await sqliteObservedTable(k, table, secondary)
}
async function globalIndexParts(
  k: Knex,
  required: Index[],
  indexes: Array<{ name: string; partial: number }>
): Promise<SqliteIndexObservation[] | undefined> {
  if (!k.isTransaction) return undefined
  const selected = required.map(index => indexes.find(value => value.name === index.name))
  if (!selected.every(index => index?.partial === 0)) return undefined
  return await readSqliteIndexObservations(
    k,
    selected.map(index => index!.name)
  )
}
async function sqliteObservedTable(
  k: Knex,
  table: Table,
  secondary: boolean,
  observed?: SqliteSchemaObservation
): Promise<boolean> {
  const observation = observed?.table === table.name ? observed : undefined
  const actual: Array<{
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
    hidden: number
  }> = observation?.columns ?? (await k.raw('PRAGMA table_xinfo(??)', [table.name]))
  const types = {
    int: 'integer',
    uint: 'integer',
    biguint: 'bigint',
    boolean: 'boolean'
  }
  if (
    !Array.isArray(actual) ||
    actual.length !== table.columns.length ||
    actual.some(
      (column, i) =>
        column.name !== table.columns[i].name ||
        column.type.toLowerCase() !== types[table.columns[i].type] ||
        column.notnull !== 1 ||
        column.dflt_value !== null ||
        column.pk !== table.primary.indexOf(column.name) + 1 ||
        column.hidden !== 0
    )
  )
    return false
  const indexes: Array<{
    name: string
    unique: number
    origin: string
    partial: number
  }> = observation?.indexes ?? (await k.raw('PRAGMA index_list(??)', [table.name]))
  if (indexes.some(index => index.unique !== 0 && (index.origin !== 'pk' || index.partial !== 0))) return false
  const required: Index[] = secondary ? [...table.indexes] : []
  if (table.primary.length > 1) {
    const primary = indexes.find(index => index.origin === 'pk')
    if (primary === undefined) return false
    required.push({ name: primary.name, columns: table.primary })
  }
  const observedParts = observation === undefined ? undefined : await globalIndexParts(k, required, indexes)
  for (const [position, index] of required.entries()) {
    const found = indexes.find(value => value.name === index.name)
    if (found?.partial !== 0) return false
    const selectedParts = observedParts?.[position]
    const parts =
      selectedParts?.name === found.name
        ? selectedParts.parts.filter(part => part.key === 1)
        : await sqliteParts(k, found.name)
    if (
      parts.length !== index.columns.length ||
      parts.some((part, i) => part.name !== index.columns[i] || part.desc !== 0 || part.coll !== 'BINARY')
    )
      return false
  }
  return true
}
async function sqliteTextOrder(k: Knex, table: string, observed?: SqliteSchemaObservation): Promise<string> {
  const indexes: Array<{ name: string; unique: number; partial: number }> =
    observed?.table === table ? observed.indexes : await k.raw('PRAGMA index_list(??)', [table])
  const eligible = indexes.filter(index => index.partial === 0 && (table !== 'proven_tx_reqs' || index.unique === 1))
  const observedParts =
    observed?.table === table
      ? await readSqliteIndexObservations(
          k,
          eligible.map(index => index.name)
        )
      : undefined
  for (const index of indexes) {
    if (index.partial !== 0 || (table === 'proven_tx_reqs' && index.unique !== 1)) continue
    const selectedParts = observedParts?.find(value => value.name === index.name)
    const parts =
      selectedParts === undefined
        ? await sqliteParts(k, index.name)
        : selectedParts.parts.filter(part => part.key === 1)
    if (
      parts[0]?.name !== 'txid' ||
      parts[0].desc !== 0 ||
      !['BINARY', 'NOCASE', 'RTRIM'].includes(parts[0].coll) ||
      (table === 'proven_tx_reqs' && parts.length !== 1)
    )
      continue
    const plan: Array<{ detail: string }> = await k.raw(
      'EXPLAIN QUERY PLAN SELECT txid FROM ?? INDEXED BY ?? ORDER BY txid LIMIT 1',
      [table, index.name]
    )
    if (!plan.some(step => step.detail.includes('TEMP B-TREE'))) return parts[0].coll
  }
  return invalid('Snapshot global source requires complete transaction lookup indexes')
}
export async function validateSqliteSource(k: Knex): Promise<void> {
  let collation: string | undefined
  const observed = await readSqliteSchemaObservations(
    k,
    sources.map(source => source.name)
  )
  await runInSeries(sources, async source => {
    const observation = observed?.find(value => value.table === source.name)
    const actual: Array<{
      name: string
      type: string
      notnull: number
      pk: number
      hidden: number
    }> = observation?.columns ?? (await k.raw('PRAGMA table_xinfo(??)', [source.name]))
    const primary = actual.filter(column => column.pk !== 0)
    if (primary.length !== 1 || primary[0]?.name !== source.key || primary[0].pk !== 1)
      invalid('Unsupported snapshot global source key')
    for (const field of source.fields) {
      const column = actual.find(value => value.name === field.name)
      if (
        column?.type.toLowerCase() !== (field.text ? 'varchar(64)' : 'integer') ||
        column.hidden !== 0 ||
        (field.name !== source.key && column.notnull !== (field.nullable ? 0 : 1))
      )
        invalid('Unsupported snapshot global source column')
    }
    if (source.name !== 'proven_txs') {
      const order = await sqliteTextOrder(k, source.name, observation)
      if (collation !== undefined && collation !== order)
        invalid('Snapshot global source comparisons require matching text definitions')
      collation = order
    }
  })
}

/** Same presence/definition error ordering as the original per-table loop.
 * Observations are created here and never accepted from a caller. */
export async function validateSqliteTables(k: Knex, definitions: Table[]): Promise<void> {
  const observed = await readSqliteSchemaObservations(
    k,
    definitions.map(table => table.name)
  )
  await runInSeries(definitions, async table => {
    if (!(await k.schema.hasTable(table.name))) invalid('Snapshot global index migration is incomplete')
    if (
      !(await sqliteObservedTable(
        k,
        table,
        true,
        observed?.find(value => value.table === table.name)
      ))
    )
      invalid('Snapshot global table definition mismatch')
  })
}
