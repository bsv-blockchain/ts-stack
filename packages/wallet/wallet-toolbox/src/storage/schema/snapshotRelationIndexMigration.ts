import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { runInSeries } from '../../utility/runInSeries'

export const SNAPSHOT_RELATION_INDEX_MIGRATION = '2026-10-01-004 add snapshot relation key indexes'

export const snapshotNumericRelations = [
  { table: 'tx_labels_map', left: 'tx_labels', leftKey: 'txLabelId', right: 'transactions', rightKey: 'transactionId' },
  { table: 'output_tags_map', left: 'output_tags', leftKey: 'outputTagId', right: 'outputs', rightKey: 'outputId' }
] as const

type Relation = (typeof snapshotNumericRelations)[number]
type Side = 'left' | 'right'
type Event = 'INSERT' | 'UPDATE' | 'DELETE'
interface Trigger {
  name: string
  table: string
  timing: 'BEFORE' | 'AFTER'
  event: Event
  body: string
  sql: string
}

const KEYS = 'snapshot_relation_keys'
const PROGRESS = 'snapshot_relation_index_progress'
const PAGE_ROWS = 256
const keyColumns = ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId']
const indexes = [
  {
    name: 'snapshot_relation_right',
    columns: ['snapshotTableId', 'snapshotUserId', 'snapshotRightId', 'snapshotLeftId']
  },
  { name: 'snapshot_relation_map', columns: ['snapshotTableId', 'snapshotLeftId', 'snapshotRightId', 'snapshotUserId'] }
]

function mysql(k: Knex): boolean {
  return String(k.client.config.client).includes('mysql')
}

function normalized(sql: string): string {
  return sql.replaceAll(/\s+/g, ' ').trim()
}

function sideInfo(relation: Relation, side: Side) {
  return side === 'left'
    ? { table: relation.left, key: relation.leftKey, index: 'snapshotLeftId', bit: 1 }
    : { table: relation.right, key: relation.rightKey, index: 'snapshotRightId', bit: 2 }
}

function insertMembership(isMysql: boolean, select: string, bit: number): string {
  const merge = isMysql
    ? ` ON DUPLICATE KEY UPDATE snapshotMembership = snapshotMembership | ${bit}`
    : ` ON CONFLICT(${keyColumns.join(', ')}) DO UPDATE SET snapshotMembership = snapshotMembership | ${bit}`
  return `INSERT INTO ${KEYS} (${keyColumns.join(', ')}, snapshotMembership) ${select}${merge};`
}

function addMapSide(isMysql: boolean, relation: Relation, tableId: number, side: Side): string {
  const { table, key, bit } = sideInfo(relation, side)
  // An explicit locking read is required even under READ COMMITTED. The parent
  // owner must stay current until this map transaction publishes its keys.
  const lock = isMysql ? ' FOR SHARE' : ''
  return insertMembership(
    isMysql,
    `SELECT ${tableId}, userId, NEW.${relation.leftKey}, NEW.${relation.rightKey}, ${bit} FROM ${table} WHERE ${key} = NEW.${key}${lock}`,
    bit
  )
}

function removeMap(relation: Relation, tableId: number): string {
  return `DELETE FROM ${KEYS} WHERE snapshotTableId = ${tableId} AND snapshotLeftId = OLD.${relation.leftKey} AND snapshotRightId = OLD.${relation.rightKey};`
}

function removeParent(relation: Relation, tableId: number, side: Side): string {
  const { key, index, bit } = sideInfo(relation, side)
  const where = `snapshotTableId = ${tableId} AND snapshotUserId = OLD.userId AND ${index} = OLD.${key}`
  return `UPDATE ${KEYS} SET snapshotMembership = snapshotMembership & ${3 ^ bit} WHERE ${where}; DELETE FROM ${KEYS} WHERE ${where} AND snapshotMembership = 0;`
}

function addParent(isMysql: boolean, relation: Relation, tableId: number, side: Side): string {
  const { key, bit } = sideInfo(relation, side)
  const lock = isMysql ? ' FOR SHARE' : ''
  const select = `SELECT ${tableId}, NEW.userId, ${relation.leftKey}, ${relation.rightKey}, ${bit} FROM ${relation.table} WHERE ${key} = NEW.${key} ORDER BY ${relation.leftKey}, ${relation.rightKey}${lock}`
  return insertMembership(isMysql, select, bit)
}

function trigger(
  isMysql: boolean,
  name: string,
  table: string,
  timing: Trigger['timing'],
  event: Event,
  statements: string,
  changed?: string
): Trigger {
  const body =
    isMysql && changed !== undefined ? `BEGIN IF ${changed} THEN ${statements} END IF; END` : `BEGIN ${statements} END`
  let qualifier = ''
  if (isMysql) qualifier = ' FOR EACH ROW'
  else if (changed !== undefined) qualifier = ` WHEN ${changed}`
  return {
    name,
    table,
    timing,
    event,
    body,
    sql: `CREATE TRIGGER ${name} ${timing} ${event} ON ${table}${qualifier} ${body}`
  }
}

export function snapshotRelationIndexTriggers(isMysql: boolean): { observers: Trigger[]; producers: Trigger[] } {
  const observers: Trigger[] = []
  const producers: Trigger[] = []
  const different = (key: string): string =>
    isMysql ? `NOT (OLD.${key} <=> NEW.${key})` : `OLD.${key} IS NOT NEW.${key}`
  for (const [tableId, relation] of snapshotNumericRelations.entries()) {
    const prefix = `snapshot_relation_${tableId}`
    const changed = `${different(relation.leftKey)} OR ${different(relation.rightKey)}`
    const remove = removeMap(relation, tableId)
    const add = addMapSide(isMysql, relation, tableId, 'left') + ' ' + addMapSide(isMysql, relation, tableId, 'right')
    observers.push(
      trigger(isMysql, `${prefix}_map_delete`, relation.table, 'AFTER', 'DELETE', remove),
      trigger(isMysql, `${prefix}_map_before_update`, relation.table, 'BEFORE', 'UPDATE', remove, changed)
    )
    producers.push(
      trigger(isMysql, `${prefix}_map_insert`, relation.table, 'AFTER', 'INSERT', add),
      trigger(isMysql, `${prefix}_map_after_update`, relation.table, 'AFTER', 'UPDATE', add, changed)
    )
    for (const side of ['left', 'right'] as const) {
      const { table, key } = sideInfo(relation, side)
      const ownerChanged = `${different(key)} OR ${different('userId')}`
      const subtract = removeParent(relation, tableId, side)
      const append = addParent(isMysql, relation, tableId, side)
      observers.push(
        trigger(isMysql, `${prefix}_${side}_delete`, table, 'AFTER', 'DELETE', subtract),
        trigger(isMysql, `${prefix}_${side}_before_update`, table, 'BEFORE', 'UPDATE', subtract, ownerChanged)
      )
      producers.push(
        trigger(isMysql, `${prefix}_${side}_insert`, table, 'AFTER', 'INSERT', append),
        trigger(isMysql, `${prefix}_${side}_after_update`, table, 'AFTER', 'UPDATE', append, ownerChanged)
      )
    }
  }
  return { observers, producers }
}

async function validateTrigger(k: Knex, expected: Trigger): Promise<boolean> {
  if (!mysql(k)) {
    const row: { sql: string } | undefined = await k('sqlite_master')
      .where({ type: 'trigger', name: expected.name })
      .first('sql')
    if (row === undefined) return false
    if (normalized(row.sql) !== normalized(expected.sql))
      throw new WERR_INVALID_OPERATION('Snapshot relation trigger definition mismatch')
    return true
  }
  const [rows]: Array<Array<{ event: string; timing: string; tableName: string; body: string }>> = await k.raw(
    'SELECT EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, EVENT_OBJECT_TABLE AS tableName, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
    [expected.name]
  )
  if (!Array.isArray(rows)) throw new WERR_INVALID_OPERATION('Invalid snapshot relation trigger metadata')
  if (rows.length === 0) return false
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.event !== expected.event ||
    row.timing !== expected.timing ||
    row.tableName !== expected.table ||
    normalized(row.body) !== normalized(expected.body)
  ) {
    throw new WERR_INVALID_OPERATION('Snapshot relation trigger definition mismatch')
  }
  return true
}

interface Column {
  name: string
  type: 'integer' | 'boolean'
  unsigned?: boolean
  primary: number
}

function tableColumns(keys: boolean): Column[] {
  if (keys)
    return [
      { name: 'snapshotTableId', type: 'integer', primary: 1 },
      { name: 'snapshotUserId', type: 'integer', unsigned: true, primary: 2 },
      { name: 'snapshotLeftId', type: 'integer', unsigned: true, primary: 3 },
      { name: 'snapshotRightId', type: 'integer', unsigned: true, primary: 4 },
      { name: 'snapshotMembership', type: 'integer', unsigned: true, primary: 0 }
    ]
  return [
    { name: 'snapshotTableId', type: 'integer', primary: 1 },
    { name: 'afterLeftId', type: 'integer', unsigned: true, primary: 0 },
    { name: 'afterRightId', type: 'integer', unsigned: true, primary: 0 },
    { name: 'complete', type: 'boolean', primary: 0 }
  ]
}

async function sqliteIndex(k: Knex, name: string, columns: string[]): Promise<boolean> {
  const rows: Array<{ name: string; desc: number; coll: string; key: number }> = await k.raw('PRAGMA index_xinfo(??)', [
    name
  ])
  const parts = rows.filter(row => row.key === 1)
  return (
    parts.length === columns.length &&
    parts.every((row, i) => row.name === columns[i] && row.desc === 0 && row.coll === 'BINARY')
  )
}

async function sqliteTable(k: Knex, table: string, keys: boolean, secondary: boolean): Promise<boolean> {
  const expected = tableColumns(keys)
  const columns: Array<{
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
    hidden: number
  }> = await k.raw('PRAGMA table_xinfo(??)', [table])
  if (
    !Array.isArray(columns) ||
    columns.length !== expected.length ||
    columns.some((column, i) => {
      const field = expected[i]
      return (
        column.name !== field.name ||
        column.type.toLowerCase() !== field.type ||
        column.notnull !== (!keys && i === 0 ? 0 : 1) ||
        column.dflt_value !== null ||
        column.pk !== field.primary ||
        column.hidden !== 0
      )
    })
  )
    return false
  const existing: Array<{ name: string; unique: number; origin: string; partial: number }> = await k.raw(
    'PRAGMA index_list(??)',
    [table]
  )
  if (existing.some(index => index.unique !== 0 && (index.origin !== 'pk' || index.partial !== 0))) return false
  if (!keys) return true
  const primary = existing.find(index => index.origin === 'pk')
  if (primary === undefined || !(await sqliteIndex(k, primary.name, keyColumns))) return false
  if (!secondary) return true
  for (const expectedIndex of indexes) {
    const found = existing.find(index => index.name === expectedIndex.name)
    if (found?.unique !== 0 || found.partial !== 0 || !(await sqliteIndex(k, found.name, expectedIndex.columns)))
      return false
  }
  return true
}

async function mysqlTable(k: Knex, table: string, keys: boolean, secondary: boolean): Promise<boolean> {
  const expected = tableColumns(keys)
  const [columns]: Array<
    Array<{ name: string; type: string; nullable: string; defaultValue: unknown; extra: string }>
  > = await k.raw(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table]
  )
  if (
    !Array.isArray(columns) ||
    columns.length !== expected.length ||
    columns.some((column, i) => {
      const field = expected[i]
      const integerType = field.unsigned === true ? 'int unsigned' : 'int'
      const type = field.type === 'boolean' ? 'tinyint' : integerType
      return (
        column.name !== field.name ||
        column.type.replaceAll(/\(\d+\)/g, '') !== type ||
        column.nullable !== 'NO' ||
        column.defaultValue !== null ||
        column.extra !== ''
      )
    })
  )
    return false
  const [parts]: Array<
    Array<{ name: string; columnName: string; nonUnique: number; direction: string; prefix: unknown }>
  > = await k.raw(
    'SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, COLLATION AS direction, SUB_PART AS prefix FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [table]
  )
  if (!Array.isArray(parts) || parts.some(index => index.name !== 'PRIMARY' && Number(index.nonUnique) !== 1))
    return false
  const required = [
    { name: 'PRIMARY', columns: keys ? keyColumns : ['snapshotTableId'] },
    ...(keys && secondary ? indexes : [])
  ]
  return required.every(index => {
    const found = parts.filter(part => part.name === index.name)
    return (
      found.length === index.columns.length &&
      found.every((part, i) => part.columnName === index.columns[i] && part.direction === 'A' && part.prefix === null)
    )
  })
}

async function validateTable(k: Knex, table: string, secondary = true): Promise<void> {
  const valid = mysql(k)
    ? await mysqlTable(k, table, table === KEYS, secondary)
    : await sqliteTable(k, table, table === KEYS, secondary)
  if (!valid) throw new WERR_INVALID_OPERATION('Snapshot relation table definition mismatch')
}

async function ensureTables(k: Knex): Promise<void> {
  if (!(await k.schema.hasTable(KEYS))) {
    await k.schema.createTable(KEYS, t => {
      t.integer('snapshotTableId').notNullable()
      t.integer('snapshotUserId').unsigned().notNullable()
      t.integer('snapshotLeftId').unsigned().notNullable()
      t.integer('snapshotRightId').unsigned().notNullable()
      t.integer('snapshotMembership').unsigned().notNullable()
      t.primary(keyColumns)
    })
  }
  // MySQL DDL commits independently. Resume an interrupted creation between
  // the table and either auxiliary index without trusting a conflicting index.
  await validateTable(k, KEYS, false)
  await runInSeries(indexes, async index => {
    const exists = mysql(k)
      ? (
          await k.raw(
            'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
            [KEYS, index.name]
          )
        )[0].length !== 0
      : (await k('sqlite_master').where({ type: 'index', name: index.name }).first('name')) !== undefined
    if (!exists)
      await k.schema.alterTable(KEYS, t => {
        t.index(index.columns, index.name)
      })
  })
  await validateTable(k, KEYS)
  if (!(await k.schema.hasTable(PROGRESS))) {
    await k.schema.createTable(PROGRESS, t => {
      t.integer('snapshotTableId').primary()
      t.integer('afterLeftId').unsigned().notNullable()
      t.integer('afterRightId').unsigned().notNullable()
      t.boolean('complete').notNullable()
    })
  }
  await validateTable(k, PROGRESS)
}

interface Position {
  afterLeftId: number
  afterRightId: number
  complete: boolean | number
}

function validPosition(state: Position | undefined): state is Position {
  return (
    state !== undefined &&
    Number.isSafeInteger(state.afterLeftId) &&
    state.afterLeftId >= 0 &&
    Number.isSafeInteger(state.afterRightId) &&
    state.afterRightId >= 0 &&
    [false, true, 0, 1].includes(state.complete)
  )
}

function positive(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1)
    throw new WERR_INVALID_OPERATION('Invalid snapshot relation source key')
  return value
}

async function bootstrapPage(k: Knex, relation: Relation, tableId: number): Promise<boolean> {
  return await k.transaction(async trx => {
    if (!mysql(k))
      await trx(PROGRESS)
        .where('snapshotTableId', tableId)
        .update({ afterLeftId: trx.ref('afterLeftId') })
    const progress = trx(PROGRESS).where('snapshotTableId', tableId)
    if (mysql(k)) void progress.forUpdate()
    const state: Position | undefined = await progress.first()
    if (!validPosition(state)) throw new WERR_INVALID_OPERATION('Invalid snapshot relation bootstrap position')
    if (state.complete === true || state.complete === 1) return true
    const source = trx(relation.table)
      .select(relation.leftKey, relation.rightKey)
      .orderBy([relation.leftKey, relation.rightKey])
      .limit(PAGE_ROWS)
    if (mysql(k)) {
      // InnoDB does not reliably range-optimize the equivalent tuple inequality.
      void source
        .whereRaw('(?? > ? OR (?? = ? AND ?? > ?))', [
          relation.leftKey,
          state.afterLeftId,
          relation.leftKey,
          state.afterLeftId,
          relation.rightKey,
          state.afterRightId
        ])
        .forUpdate()
    } else {
      void source.whereRaw('(??, ??) > (?, ?)', [
        relation.leftKey,
        relation.rightKey,
        state.afterLeftId,
        state.afterRightId
      ])
    }
    const rows: Array<Record<string, number>> = await source
    for (const row of rows) {
      positive(row[relation.leftKey])
      positive(row[relation.rightKey])
    }
    await runInSeries(['left', 'right'] as const, async side => {
      const { table, key, bit } = sideInfo(relation, side)
      const ids = [...new Set(rows.map(row => row[key]))].sort((a, b) => a - b)
      if (ids.length === 0) return
      const query = trx(table).select(key, 'userId').whereIn(key, ids).orderBy(key)
      if (mysql(k)) void query.forShare()
      const parents: Array<Record<string, number>> = await query
      const owners = new Map(parents.map(row => [positive(row[key]), positive(row.userId)]))
      const memberships = rows.flatMap(row => {
        const owner = owners.get(row[key])
        return owner === undefined
          ? []
          : [
              {
                snapshotTableId: tableId,
                snapshotUserId: owner,
                snapshotLeftId: row[relation.leftKey],
                snapshotRightId: row[relation.rightKey],
                snapshotMembership: bit
              }
            ]
      })
      if (memberships.length !== 0)
        await trx(KEYS)
          .insert(memberships)
          .onConflict(keyColumns)
          .merge({ snapshotMembership: trx.raw('?? | ?', ['snapshotMembership', bit]) })
    })
    const last = rows.at(-1)
    const complete = rows.length < PAGE_ROWS
    await trx(PROGRESS)
      .where('snapshotTableId', tableId)
      .update({
        afterLeftId: last?.[relation.leftKey] ?? state.afterLeftId,
        afterRightId: last?.[relation.rightKey] ?? state.afterRightId,
        complete
      })
    return complete
  })
}

/** Keep standard schema and cursor order intact while indexing OR ownership. */
export async function addSnapshotRelationIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION('Snapshot relation migration requires independent DDL and bootstrap transactions')
  await ensureTables(k)
  const { observers, producers } = snapshotRelationIndexTriggers(mysql(k))
  // Every graph-wide removal observer precedes every possible producer.
  await runInSeries([...observers, ...producers], async expected => {
    if (!(await validateTrigger(k, expected))) await k.raw(expected.sql)
  })
  await runInSeries(snapshotNumericRelations.entries(), async ([tableId, relation]) => {
    await k(PROGRESS)
      .insert({ snapshotTableId: tableId, afterLeftId: 0, afterRightId: 0, complete: false })
      .onConflict('snapshotTableId')
      .ignore()
    let complete = false
    function* unfinishedPages() {
      while (!complete) yield undefined
    }
    await runInSeries(unfinishedPages(), async () => {
      complete = await bootstrapPage(k, relation, tableId)
    })
  })
}

/** Readers must be drained before removal; standard rows remain intact. */
export async function removeSnapshotRelationIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION('Snapshot relation migration requires independent DDL and bootstrap transactions')
  if (await k.schema.hasTable(KEYS)) await validateTable(k, KEYS)
  if (await k.schema.hasTable(PROGRESS)) await validateTable(k, PROGRESS)
  const { observers, producers } = snapshotRelationIndexTriggers(mysql(k))
  const ordered = [...producers, ...observers]
  await runInSeries(ordered, async expected => {
    await validateTrigger(k, expected)
  })
  await runInSeries(ordered, async expected => {
    await k.raw('DROP TRIGGER IF EXISTS ??', [expected.name])
  })
  await k.schema.dropTableIfExists(PROGRESS)
  await k.schema.dropTableIfExists(KEYS)
}

/** Read inside the same retained view as the snapshot header and table pages. */
export async function readSnapshotRelationIndexState(k: Knex, config?: Knex.MigratorConfig): Promise<boolean> {
  const tableName = config?.tableName ?? 'knex_migrations'
  const schema = k.schema
  if (config?.schemaName !== undefined) void schema.withSchema(config.schemaName)
  if (!(await schema.hasTable(tableName))) return false
  const journal = k(tableName).where('name', SNAPSHOT_RELATION_INDEX_MIGRATION)
  if (config?.schemaName !== undefined) void journal.withSchema(config.schemaName)
  if ((await journal.first('name')) === undefined) return false
  if (!(await k.schema.hasTable(KEYS)) || !(await k.schema.hasTable(PROGRESS)))
    throw new WERR_INVALID_OPERATION('Snapshot relation index migration is incomplete')
  await validateTable(k, KEYS)
  await validateTable(k, PROGRESS)
  const states: Array<Position & { snapshotTableId: number }> = await k(PROGRESS)
    .select('snapshotTableId', 'afterLeftId', 'afterRightId', 'complete')
    .orderBy('snapshotTableId')
    .limit(snapshotNumericRelations.length + 1)
  if (
    states.length !== snapshotNumericRelations.length ||
    states.some(
      (state, i) =>
        state.snapshotTableId !== i || !validPosition(state) || (state.complete !== true && state.complete !== 1)
    )
  )
    throw new WERR_INVALID_OPERATION('Snapshot relation index migration is incomplete')
  return true
}
