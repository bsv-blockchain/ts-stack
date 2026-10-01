import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { runInSeries } from '../../utility/runInSeries'
import { snapshotGlobalIndexTriggers, type SnapshotGlobalIndexTrigger } from './snapshotGlobalIndexTriggers'

export const SNAPSHOT_GLOBAL_INDEX_MIGRATION = '2026-10-01-006 add snapshot global reference indexes'
const EDGES = 'snapshot_global_edges'
const KEYS = 'snapshot_global_keys'
const GUARDS = 'snapshot_global_guards'
const PROGRESS = 'snapshot_global_index_progress'
const PAGE_ROWS = 256

type ColumnType = 'int' | 'uint' | 'biguint' | 'boolean'
interface Column {
  name: string
  type: ColumnType
}
interface Index {
  name: string
  columns: string[]
}
interface Table {
  name: string
  columns: Column[]
  primary: string[]
  indexes: Index[]
}
const columns = (names: string[], type: ColumnType): Column[] => names.map(name => ({ name, type }))
const tables: Table[] = [
  {
    name: GUARDS,
    columns: [...columns(['proofId'], 'uint'), ...columns(['present'], 'boolean')],
    primary: ['proofId'],
    indexes: []
  },
  {
    name: KEYS,
    columns: [
      ...columns(['tableId'], 'int'),
      ...columns(['userId', 'rowId'], 'uint'),
      ...columns(['refs'], 'biguint'),
      ...columns(['present'], 'boolean')
    ],
    primary: ['tableId', 'userId', 'rowId'],
    indexes: [
      {
        name: 'snapshot_global_page',
        columns: ['tableId', 'userId', 'present', 'rowId']
      },
      {
        name: 'snapshot_global_target',
        columns: ['tableId', 'rowId', 'userId']
      }
    ]
  },
  {
    name: EDGES,
    columns: [
      ...columns(['transactionId', 'requestId'], 'uint'),
      ...columns(['tableId'], 'int'),
      ...columns(['rowId', 'userId'], 'uint')
    ],
    primary: ['transactionId', 'requestId', 'tableId', 'rowId'],
    indexes: [
      {
        name: 'snapshot_global_request',
        columns: ['requestId', 'transactionId']
      }
    ]
  },
  {
    name: PROGRESS,
    columns: [...columns(['id'], 'int'), ...columns(['afterRowId'], 'uint'), ...columns(['complete'], 'boolean')],
    primary: ['id'],
    indexes: []
  }
]
const mysql = (k: Knex): boolean => String(k.client.config.client).includes('mysql')
const normalized = (sql: string): string => sql.replaceAll(/\s+/g, ' ').trim()
function invalid(message: string): never {
  throw new WERR_INVALID_OPERATION(message)
}
interface MysqlPart {
  name: string
  columnName: string
  nonUnique: number
  direction: string
  prefix: unknown
}
async function mysqlParts(k: Knex, table: string): Promise<MysqlPart[]> {
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
async function mysqlTable(k: Knex, table: Table, secondary: boolean): Promise<boolean> {
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
async function sqliteTable(k: Knex, table: Table, secondary: boolean): Promise<boolean> {
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
async function validateTable(k: Knex, table: Table, secondary = true): Promise<void> {
  if (!(mysql(k) ? await mysqlTable(k, table, secondary) : await sqliteTable(k, table, secondary)))
    invalid('Snapshot global table definition mismatch')
}
async function ensureTable(k: Knex, table: Table): Promise<void> {
  if (!(await k.schema.hasTable(table.name)))
    await k.schema.createTable(table.name, builder => {
      if (mysql(k)) void builder.engine('InnoDB')
      for (const column of table.columns) {
        let field: Knex.ColumnBuilder
        if (column.type === 'boolean') field = builder.boolean(column.name)
        else if (column.type === 'biguint') field = builder.bigInteger(column.name).unsigned()
        else if (column.type === 'uint') field = builder.integer(column.name).unsigned()
        else field = builder.integer(column.name)
        void field.notNullable()
      }
      void builder.primary(table.primary)
    })
  await validateTable(k, table, false)
  await runInSeries(table.indexes, async index => {
    const exists = mysql(k)
      ? (await mysqlParts(k, table.name)).some(part => part.name === index.name)
      : (await k('sqlite_master').where({ type: 'index', name: index.name }).first('name')) !== undefined
    if (!exists)
      await k.schema.alterTable(table.name, builder => {
        void builder.index(index.columns, index.name)
      })
  })
  await validateTable(k, table)
}

const sources = [
  {
    name: 'proven_txs',
    key: 'provenTxId',
    fields: [{ name: 'provenTxId', nullable: false, text: false }]
  },
  {
    name: 'proven_tx_reqs',
    key: 'provenTxReqId',
    fields: [
      { name: 'provenTxReqId', nullable: false, text: false },
      { name: 'provenTxId', nullable: true, text: false },
      { name: 'txid', nullable: false, text: true }
    ]
  },
  {
    name: 'transactions',
    key: 'transactionId',
    fields: [
      { name: 'transactionId', nullable: false, text: false },
      { name: 'userId', nullable: false, text: false },
      { name: 'provenTxId', nullable: true, text: false },
      { name: 'txid', nullable: true, text: true }
    ]
  }
]
interface MysqlSourceColumn {
  name: string
  type: string
  nullable: string
  extra: string
  charset: string | null
  collation: string | null
}
type SourceDefinition = (typeof sources)[number]
type SourceField = SourceDefinition['fields'][number]
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
async function validateMysqlSource(k: Knex): Promise<void> {
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
async function validateSqliteSource(k: Knex): Promise<void> {
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
async function validateSource(k: Knex): Promise<void> {
  if (mysql(k)) await validateMysqlSource(k)
  else await validateSqliteSource(k)
}
async function validateTrigger(k: Knex, expected: SnapshotGlobalIndexTrigger): Promise<boolean> {
  if (!mysql(k)) {
    const row: { sql: string } | undefined = await k('sqlite_master')
      .where({ type: 'trigger', name: expected.name })
      .first('sql')
    if (row === undefined) return false
    if (normalized(row.sql) !== normalized(expected.sql)) invalid('Snapshot global trigger definition mismatch')
    return true
  }
  const [rows]: Array<Array<{ event: string; timing: string; tableName: string; body: string }>> = await k.raw(
    'SELECT EVENT_MANIPULATION AS event,ACTION_TIMING AS timing,EVENT_OBJECT_TABLE AS tableName,ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?',
    [expected.name]
  )
  if (!Array.isArray(rows)) invalid('Invalid snapshot global trigger metadata')
  if (rows.length === 0) return false
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.event !== expected.event ||
    row.timing !== expected.timing ||
    row.tableName !== expected.table ||
    normalized(row.body) !== normalized(expected.body)
  )
    invalid('Snapshot global trigger definition mismatch')
  return true
}

interface Position {
  afterRowId: number
  complete: boolean | number
}
function validPosition(state: Position | undefined): state is Position {
  return (
    state !== undefined &&
    Number.isSafeInteger(state.afterRowId) &&
    state.afterRowId >= 0 &&
    [false, true, 0, 1].includes(state.complete)
  )
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid('Invalid snapshot global source key')
  return value
}
interface SourceRow {
  transactionId: number
  userId: number
  provenTxId: number | null
  txid: string | null
  txidBytes: number
}
interface RequestRow {
  provenTxReqId: number
  provenTxId: number | null
}
async function currentProof(k: Knex, proofId: number): Promise<void> {
  positive(proofId)
  await k(GUARDS)
    .insert({ proofId, present: false })
    .onConflict('proofId')
    .merge({ proofId: k.ref('proofId') })
  // This lock is shared with proof insert/delete triggers, including absence.
  // UPDATE reads the current source after acquiring the auxiliary target lock.
  if (mysql(k))
    await k.raw(
      'UPDATE snapshot_global_guards g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=?',
      [proofId]
    )
  else
    await k(GUARDS)
      .where('proofId', proofId)
      .update({
        present: k.raw('EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=?)', [proofId])
      })
}
async function bootstrapRow(k: Knex, row: SourceRow): Promise<void> {
  positive(row.transactionId)
  positive(row.userId)
  if (
    !Number.isSafeInteger(row.txidBytes) ||
    row.txidBytes < 0 ||
    row.txidBytes > 256 ||
    (row.txid !== null && (typeof row.txid !== 'string' || Array.from(row.txid).length > 64))
  )
    invalid('Invalid snapshot global transaction key')
  let request: RequestRow | undefined
  if (row.txid !== null) {
    const query = k('proven_tx_reqs').select('provenTxReqId', 'provenTxId').where('txid', row.txid)
    if (mysql(k)) void query.forShare()
    request = await query.first()
    if (request !== undefined) positive(request.provenTxReqId)
  }
  const proofs = [
    ...new Set(
      [row.provenTxId, request?.provenTxId].filter((value): value is number => value !== null && value !== undefined)
    )
  ].sort((a, b) => a - b)
  await runInSeries(proofs, async proofId => {
    await currentProof(k, proofId)
  })
  const values: Array<{ requestId: number; tableId: number; rowId: number }> = []
  if (row.provenTxId !== null) values.push({ requestId: 0, tableId: 1, rowId: positive(row.provenTxId) })
  if (request !== undefined) {
    values.push({
      requestId: request.provenTxReqId,
      tableId: 0,
      rowId: request.provenTxReqId
    })
    if (request.provenTxId !== null)
      values.push({
        requestId: request.provenTxReqId,
        tableId: 1,
        rowId: positive(request.provenTxId)
      })
  }
  if (values.length !== 0)
    await k(EDGES)
      .insert(
        values.map(value => ({
          ...value,
          transactionId: row.transactionId,
          userId: row.userId
        }))
      )
      .onConflict(['transactionId', 'requestId', 'tableId', 'rowId'])
      .merge({ transactionId: k.ref('transactionId') })
}
async function bootstrapPage(k: Knex): Promise<boolean> {
  return await k.transaction(async trx => {
    if (!mysql(k))
      await trx(PROGRESS)
        .where('id', 0)
        .update({ complete: trx.ref('complete') })
    const position = trx(PROGRESS).where('id', 0)
    if (mysql(k)) void position.forUpdate()
    const state: Position | undefined = await position.first()
    if (!validPosition(state)) invalid('Invalid snapshot global bootstrap position')
    if (state.complete === true || state.complete === 1) return true
    if (state.afterRowId === 0) {
      // The initial position is below every supported source key. Do not mark a
      // malformed legacy SQLite store complete while silently skipping its rows.
      const unsupported = trx('transactions').select('transactionId').where('transactionId', '<=', 0)
      if (mysql(k)) void unsupported.forUpdate()
      if ((await unsupported.first()) !== undefined) invalid('Invalid snapshot global source key')
    }
    const length = mysql(k) ? 'octet_length(txid)' : 'length(cast(txid AS blob))'
    const source = trx('transactions')
      .select(
        'transactionId',
        'userId',
        'provenTxId',
        trx.raw(`CASE WHEN ${length} <= 256 THEN txid END AS txid`),
        trx.raw(`COALESCE(${length},0) AS txidBytes`)
      )
      .where('transactionId', '>', state.afterRowId)
      .orderBy('transactionId')
      .limit(PAGE_ROWS)
    if (mysql(k)) void source.forUpdate()
    const rows: SourceRow[] = await source
    await runInSeries(rows, async row => {
      await bootstrapRow(trx, row)
    })
    const complete = rows.length < PAGE_ROWS
    await trx(PROGRESS)
      .where('id', 0)
      .update({
        afterRowId: rows.at(-1)?.transactionId ?? state.afterRowId,
        complete
      })
    return complete
  })
}
export async function addSnapshotGlobalIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    invalid('Snapshot global migration requires independent DDL and bootstrap transactions')
  await validateSource(k)
  await runInSeries(tables, async table => {
    await ensureTable(k, table)
  })
  await runInSeries(snapshotGlobalIndexTriggers(mysql(k)), async trigger => {
    if (!(await validateTrigger(k, trigger))) await k.raw(trigger.sql)
  })
  await k(PROGRESS).insert({ id: 0, afterRowId: 0, complete: false }).onConflict('id').ignore()
  let complete = false
  function* unfinishedPages() {
    while (!complete) yield undefined
  }
  await runInSeries(unfinishedPages(), async () => {
    complete = await bootstrapPage(k)
  })
}
/** Drain retained readers before removal; all standard source rows/indexes remain. */
export async function removeSnapshotGlobalIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    invalid('Snapshot global migration requires independent DDL and bootstrap transactions')
  await validateSource(k)
  await runInSeries(tables, async table => {
    if (await k.schema.hasTable(table.name)) await validateTable(k, table)
  })
  const triggers = snapshotGlobalIndexTriggers(mysql(k)).reverse()
  await runInSeries(triggers, async trigger => {
    await validateTrigger(k, trigger)
  })
  await runInSeries(triggers, async trigger => {
    await k.raw('DROP TRIGGER IF EXISTS ??', [trigger.name])
  })
  await runInSeries([...tables].reverse(), async table => {
    await k.schema.dropTableIfExists(table.name)
  })
}
export async function readSnapshotGlobalIndexState(k: Knex, config?: Knex.MigratorConfig): Promise<boolean> {
  const tableName = config?.tableName ?? 'knex_migrations',
    schema = k.schema
  if (config?.schemaName !== undefined) void schema.withSchema(config.schemaName)
  if (!(await schema.hasTable(tableName))) return false
  const journal = k(tableName).where('name', SNAPSHOT_GLOBAL_INDEX_MIGRATION)
  if (config?.schemaName !== undefined) void journal.withSchema(config.schemaName)
  if ((await journal.first('name')) === undefined) return false
  await validateSource(k)
  await runInSeries(tables, async table => {
    if (!(await k.schema.hasTable(table.name))) invalid('Snapshot global index migration is incomplete')
    await validateTable(k, table)
  })
  const states: Array<Position & { id: number }> = await k(PROGRESS).select('*').limit(2)
  if (
    states.length !== 1 ||
    states[0]?.id !== 0 ||
    !validPosition(states[0]) ||
    (states[0].complete !== true && states[0].complete !== 1)
  )
    invalid('Snapshot global index migration is incomplete')
  return true
}
