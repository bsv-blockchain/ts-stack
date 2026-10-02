import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { invalid, sources, type Table, type Index } from './snapshotGlobalIndexModel'
interface SqlitePart {
  name: string
  desc: number
  coll: string
  key: number
}
async function sqliteParts(k: Knex, name: string): Promise<SqlitePart[]> {
  const rows: SqlitePart[] = await k.raw('PRAGMA index_xinfo(??)', [name])
  return rows.filter(row => row.key === 1)
}
export async function sqliteTable(k: Knex, table: Table, secondary: boolean): Promise<boolean> {
  const actual: Array<{
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
    hidden: number
  }> = await k.raw('PRAGMA table_xinfo(??)', [table.name])
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
  }> = await k.raw('PRAGMA index_list(??)', [table.name])
  if (indexes.some(index => index.unique !== 0 && (index.origin !== 'pk' || index.partial !== 0))) return false
  const required: Index[] = secondary ? [...table.indexes] : []
  if (table.primary.length > 1) {
    const primary = indexes.find(index => index.origin === 'pk')
    if (primary === undefined) return false
    required.push({ name: primary.name, columns: table.primary })
  }
  for (const index of required) {
    const found = indexes.find(value => value.name === index.name)
    if (found === undefined || found.partial !== 0) return false
    const parts = await sqliteParts(k, found.name)
    if (
      parts.length !== index.columns.length ||
      parts.some((part, i) => part.name !== index.columns[i] || part.desc !== 0 || part.coll !== 'BINARY')
    )
      return false
  }
  return true
}
async function sqliteTextOrder(k: Knex, table: string): Promise<string> {
  const indexes: Array<{ name: string; unique: number; partial: number }> = await k.raw('PRAGMA index_list(??)', [
    table
  ])
  for (const index of indexes) {
    if (index.partial !== 0 || (table === 'proven_tx_reqs' && index.unique !== 1)) continue
    const parts = await sqliteParts(k, index.name)
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
  await runInSeries(sources, async source => {
    const actual: Array<{
      name: string
      type: string
      notnull: number
      pk: number
      hidden: number
    }> = await k.raw('PRAGMA table_xinfo(??)', [source.name])
    const primary = actual.filter(column => column.pk !== 0)
    if (primary.length !== 1 || primary[0]?.name !== source.key || primary[0].pk !== 1)
      invalid('Unsupported snapshot global source key')
    for (const field of source.fields) {
      const column = actual.find(value => value.name === field.name)
      if (
        column === undefined ||
        column.type.toLowerCase() !== (field.text ? 'varchar(64)' : 'integer') ||
        column.hidden !== 0 ||
        (field.name !== source.key && column.notnull !== (field.nullable ? 0 : 1))
      )
        invalid('Unsupported snapshot global source column')
    }
    if (source.name !== 'proven_txs') {
      const order = await sqliteTextOrder(k, source.name)
      if (collation !== undefined && collation !== order)
        invalid('Snapshot global source comparisons require matching text definitions')
      collation = order
    }
  })
}
