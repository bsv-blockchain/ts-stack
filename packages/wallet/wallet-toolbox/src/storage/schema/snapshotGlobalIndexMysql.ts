import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { invalid, sources, type Table, type SourceDefinition, type SourceField } from './snapshotGlobalIndexModel'
interface MysqlPart {
  name: string
  columnName: string
  nonUnique: number
  direction: string
  prefix: unknown
}
export async function mysqlParts(k: Knex, table: string): Promise<MysqlPart[]> {
  const [parts]: MysqlPart[][] = await k.raw(
    'SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, COLLATION AS direction, SUB_PART AS prefix FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',
    [table]
  )
  if (!Array.isArray(parts)) invalid('Invalid snapshot global index metadata')
  return parts
}
function matchesMysqlIndex(parts: MysqlPart[], name: string, expected: string[]): boolean {
  const found = parts.filter(part => part.name === name)
  return (
    found.length === expected.length &&
    found.every((part, i) => part.columnName === expected[i] && part.direction === 'A' && part.prefix === null)
  )
}
export async function mysqlTable(k: Knex, table: Table, secondary: boolean): Promise<boolean> {
  const [engines]: Array<Array<{ engine: string }>> = await k.raw(
    'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [table.name]
  )
  if (engines.length !== 1 || engines[0]?.engine !== 'InnoDB') return false
  const [actual]: Array<
    Array<{
      name: string
      type: string
      nullable: string
      defaultValue: unknown
      extra: string
    }>
  > = await k.raw(
    'SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
    [table.name]
  )
  const types = {
    int: 'int',
    uint: 'int unsigned',
    biguint: 'bigint unsigned',
    boolean: 'tinyint'
  }
  if (
    !Array.isArray(actual) ||
    actual.length !== table.columns.length ||
    actual.some(
      (column, i) =>
        column.name !== table.columns[i].name ||
        column.type.replaceAll(/\(\d+\)/g, '') !== types[table.columns[i].type] ||
        column.nullable !== 'NO' ||
        column.defaultValue !== null ||
        column.extra !== ''
    )
  )
    return false
  const parts = await mysqlParts(k, table.name)
  if (parts.some(part => part.name !== 'PRIMARY' && Number(part.nonUnique) !== 1)) return false
  if (!matchesMysqlIndex(parts, 'PRIMARY', table.primary)) return false
  return !secondary || table.indexes.every(index => matchesMysqlIndex(parts, index.name, index.columns))
}
interface MysqlSourceColumn {
  name: string
  type: string
  nullable: string
  extra: string
  charset: string | null
  collation: string | null
}
interface SourceText {
  charset: string
  collation: string
}
function mysqlSourceColumn(column: MysqlSourceColumn | undefined, field: SourceField, key: string): MysqlSourceColumn {
  const type = field.text ? 'varchar(64)' : 'int unsigned'
  if (
    column === undefined ||
    (field.text ? column.type : column.type.replaceAll(/\(\d+\)/g, '')) !== type ||
    column.nullable !== (field.nullable ? 'YES' : 'NO') ||
    (column.extra !== '' && !(field.name === key && column.extra === 'auto_increment'))
  )
    invalid('Unsupported snapshot global source column')
  return column
}
function mysqlSourceText(previous: SourceText | undefined, column: MysqlSourceColumn): SourceText {
  if (column.charset === null || column.collation === null) invalid('Unsupported snapshot global source text')
  if (previous !== undefined && (previous.charset !== column.charset || previous.collation !== column.collation))
    invalid('Snapshot global source comparisons require matching text definitions')
  return { charset: column.charset, collation: column.collation }
}
function validateMysqlSourceIndexes(parts: MysqlPart[], source: SourceDefinition): void {
  if (!matchesMysqlIndex(parts, 'PRIMARY', [source.key])) invalid('Unsupported snapshot global source key')
  if (source.name === 'proven_txs') return
  const candidates = [...new Set(parts.map(part => part.name))]
  const indexed = candidates.some(name => {
    const index = parts.filter(part => part.name === name)
    return (
      index[0]?.columnName === 'txid' &&
      index[0].direction === 'A' &&
      index[0].prefix === null &&
      (source.name === 'transactions' || (index.length === 1 && Number(index[0].nonUnique) === 0))
    )
  })
  if (!indexed) invalid('Snapshot global source requires complete transaction lookup indexes')
}
export async function validateMysqlSource(k: Knex): Promise<void> {
  let text: SourceText | undefined
  await runInSeries(sources, async source => {
    const [engines]: Array<Array<{ engine: string }>> = await k.raw(
      'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [source.name]
    )
    if (engines.length !== 1 || engines[0]?.engine !== 'InnoDB')
      invalid('Snapshot global source requires transactional tables')
    const [rules]: Array<Array<{ updateRule: string; deleteRule: string }>> = await k.raw(
      'SELECT UPDATE_RULE AS updateRule,DELETE_RULE AS deleteRule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [source.name]
    )
    // InnoDB cascades do not run the affected child's row triggers. Keep the
    // standard RESTRICT/NO ACTION definitions; do not adopt a stale edge index.
    const explicit = (rule: string): boolean => rule === 'RESTRICT' || rule === 'NO ACTION'
    if (!Array.isArray(rules) || rules.some(rule => !explicit(rule.updateRule) || !explicit(rule.deleteRule)))
      invalid('Snapshot global source requires explicit row mutations')
    const [actual]: MysqlSourceColumn[][] = await k.raw(
      'SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,EXTRA AS extra,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [source.name]
    )
    for (const field of source.fields) {
      const column = mysqlSourceColumn(
        actual.find(value => value.name === field.name),
        field,
        source.key
      )
      if (field.text) text = mysqlSourceText(text, column)
    }
    validateMysqlSourceIndexes(await mysqlParts(k, source.name), source)
  })
}
