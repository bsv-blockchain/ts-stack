import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { runInSeries } from '../../utility/runInSeries'

export const SNAPSHOT_CERTIFICATE_INDEX_MIGRATION = '2026-10-01-005 add snapshot certificate field key indexes'
const KEYS = 'snapshot_certificate_field_keys'
const PROGRESS = 'snapshot_certificate_index_progress'
const PAGE_ROWS = 256
const keyColumns = ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId']
const indexes = [
  {
    name: 'snapshot_certificate_parent',
    columns: ['snapshotCertificateId', 'snapshotUserId', 'snapshotFieldName']
  },
  {
    name: 'snapshot_certificate_lookup',
    columns: ['snapshotFieldName', 'snapshotCertificateId', 'snapshotUserId']
  }
]
type Event = 'INSERT' | 'UPDATE' | 'DELETE'
interface Trigger {
  name: string
  table: string
  timing: 'BEFORE' | 'AFTER'
  event: Event
  body: string
  sql: string
}
interface TextDefinition {
  charset: string | null
  collation: string
}
function mysql(k: Knex): boolean {
  return String(k.client.config.client).includes('mysql')
}
function normalized(sql: string): string {
  return sql.replaceAll(/\s+/g, ' ').trim()
}
const textColumn = (name: string): boolean => name === 'snapshotFieldName' || name === 'afterFieldName'

async function sourceText(k: Knex): Promise<TextDefinition> {
  if (mysql(k)) {
    const [tables]: Array<Array<{ name: string; engine: string }>> = await k.raw(
      'SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?) ORDER BY TABLE_NAME',
      ['certificate_fields', 'certificates']
    )
    if (tables.length !== 2 || tables.some(table => table.engine !== 'InnoDB'))
      throw new WERR_INVALID_OPERATION('Snapshot certificate source requires transactional tables')
    const [columns]: Array<
      Array<{
        type: string
        nullable: string
        charset: string
        collation: string
      }>
    > = await k.raw(
      'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['certificate_fields', 'fieldName']
    )
    const column = columns[0]
    if (
      columns.length !== 1 ||
      column?.type !== 'varchar(100)' ||
      column.nullable !== 'NO' ||
      !/^\w+$/.test(column.charset) ||
      !/^\w+$/.test(column.collation)
    )
      throw new WERR_INVALID_OPERATION('Unsupported snapshot certificate field definition')
    return { charset: column.charset, collation: column.collation }
  }
  const unique: Array<{ name: string; unique: number; partial: number }> = await k.raw('PRAGMA index_list(??)', [
    'certificate_fields'
  ])
  for (const index of unique) {
    if (index.unique !== 1 || index.partial !== 0) continue
    const info: Array<{
      name: string
      key: number
      desc: number
      coll: string
    }> = await k.raw('PRAGMA index_xinfo(??)', [index.name])
    const parts = info.filter(part => part.key === 1)
    if (
      parts.length !== 2 ||
      parts[0]?.name !== 'fieldName' ||
      parts[1]?.name !== 'certificateId' ||
      parts.some(part => part.desc !== 0) ||
      parts[1].coll !== 'BINARY' ||
      !['BINARY', 'NOCASE', 'RTRIM'].includes(parts[0].coll)
    )
      continue
    // A forced unique index must satisfy the declared column order itself.
    // A separately collated index that needs a sort cannot define our cursor.
    const plan: Array<{ detail: string }> = await k.raw(
      'EXPLAIN QUERY PLAN SELECT fieldName, certificateId FROM certificate_fields INDEXED BY ?? ORDER BY fieldName, certificateId LIMIT 1',
      [index.name]
    )
    if (plan.some(step => step.detail.includes('TEMP B-TREE'))) continue
    return { charset: null, collation: parts[0].coll }
  }
  throw new WERR_INVALID_OPERATION('Unsupported snapshot certificate field order')
}

function fieldType(text: TextDefinition): string {
  const charset = text.charset === null ? '' : ' CHARACTER SET ' + text.charset
  return `varchar(100)${charset} COLLATE ${text.collation}`
}
function insertMembership(isMysql: boolean, select: string, bit: number): string {
  const merge = isMysql
    ? ` ON DUPLICATE KEY UPDATE snapshotMembership = ${KEYS}.snapshotMembership | ${bit}`
    : ` ON CONFLICT(${keyColumns.join(', ')}) DO UPDATE SET snapshotMembership = snapshotMembership | ${bit}`
  return `INSERT INTO ${KEYS} (${keyColumns.join(', ')}, snapshotMembership) ${select}${merge};`
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

export function snapshotCertificateIndexTriggers(isMysql: boolean): {
  observers: Trigger[]
  producers: Trigger[]
} {
  const different = (key: string): string =>
    isMysql ? `NOT (OLD.${key} <=> NEW.${key})` : `OLD.${key} IS NOT NEW.${key}`
  const fieldChanged = isMysql
    ? 'NOT (CAST(OLD.fieldName AS BINARY) <=> CAST(NEW.fieldName AS BINARY))'
    : 'CAST(OLD.fieldName AS BLOB) IS NOT CAST(NEW.fieldName AS BLOB)'
  const changed = `${different('userId')} OR ${fieldChanged} OR ${different('certificateId')}`
  const ownerChanged = `${different('userId')} OR ${different('certificateId')}`
  const lock = isMysql ? ' FOR SHARE' : ''
  const remove = `DELETE FROM ${KEYS} WHERE snapshotFieldName = OLD.fieldName AND snapshotCertificateId = OLD.certificateId;`
  const add =
    insertMembership(isMysql, 'VALUES(NEW.userId, NEW.fieldName, NEW.certificateId, 1)', 1) +
    ' ' +
    insertMembership(
      isMysql,
      `SELECT userId, NEW.fieldName, NEW.certificateId, 2 FROM certificates WHERE certificateId = NEW.certificateId${lock}`,
      2
    )
  const where = 'snapshotUserId = OLD.userId AND snapshotCertificateId = OLD.certificateId'
  const subtract = `UPDATE ${KEYS} SET snapshotMembership = snapshotMembership & 1 WHERE ${where}; DELETE FROM ${KEYS} WHERE ${where} AND snapshotMembership = 0;`
  // Direct memberships exist even when parent ownership is absent or differs.
  // They supply a bounded parent prefix without changing legacy source indexes.
  const join = isMysql ? 'JOIN' : 'CROSS JOIN'
  const append = insertMembership(
    isMysql,
    `SELECT NEW.userId, f.fieldName, f.certificateId, 2 FROM ${KEYS} k ${join} certificate_fields f ON f.fieldName = k.snapshotFieldName AND f.certificateId = k.snapshotCertificateId WHERE k.snapshotCertificateId = NEW.certificateId AND (k.snapshotMembership & 1) = 1 ORDER BY k.snapshotFieldName, k.snapshotUserId${lock}`,
    2
  )
  const prefix = 'snapshot_certificate'
  return {
    observers: [
      trigger(isMysql, `${prefix}_field_delete`, 'certificate_fields', 'AFTER', 'DELETE', remove),
      trigger(isMysql, `${prefix}_field_before_update`, 'certificate_fields', 'BEFORE', 'UPDATE', remove, changed),
      trigger(isMysql, `${prefix}_parent_delete`, 'certificates', 'AFTER', 'DELETE', subtract),
      trigger(isMysql, `${prefix}_parent_before_update`, 'certificates', 'BEFORE', 'UPDATE', subtract, ownerChanged)
    ],
    producers: [
      trigger(isMysql, `${prefix}_field_insert`, 'certificate_fields', 'AFTER', 'INSERT', add),
      trigger(isMysql, `${prefix}_field_after_update`, 'certificate_fields', 'AFTER', 'UPDATE', add, changed),
      trigger(isMysql, `${prefix}_parent_insert`, 'certificates', 'AFTER', 'INSERT', append),
      trigger(isMysql, `${prefix}_parent_after_update`, 'certificates', 'AFTER', 'UPDATE', append, ownerChanged)
    ]
  }
}
async function validateTrigger(k: Knex, expected: Trigger): Promise<boolean> {
  if (!mysql(k)) {
    const row: { sql: string } | undefined = await k('sqlite_master')
      .where({ type: 'trigger', name: expected.name })
      .first('sql')
    if (row === undefined) return false
    if (normalized(row.sql) !== normalized(expected.sql))
      throw new WERR_INVALID_OPERATION('Snapshot certificate trigger definition mismatch')
    return true
  }
  const [rows]: Array<Array<{ event: string; timing: string; tableName: string; body: string }>> = await k.raw(
    'SELECT EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, EVENT_OBJECT_TABLE AS tableName, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
    [expected.name]
  )
  if (!Array.isArray(rows)) throw new WERR_INVALID_OPERATION('Invalid snapshot certificate trigger metadata')
  if (rows.length === 0) return false
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.event !== expected.event ||
    row.timing !== expected.timing ||
    row.tableName !== expected.table ||
    normalized(row.body) !== normalized(expected.body)
  ) {
    throw new WERR_INVALID_OPERATION('Snapshot certificate trigger definition mismatch')
  }
  return true
}

interface Column {
  name: string
  type: 'integer' | 'boolean' | 'varchar(100)'
  unsigned?: boolean
  primary: number
}
function tableColumns(keys: boolean): Column[] {
  if (keys)
    return [
      { name: 'snapshotUserId', type: 'integer', unsigned: true, primary: 1 },
      { name: 'snapshotFieldName', type: 'varchar(100)', primary: 2 },
      {
        name: 'snapshotCertificateId',
        type: 'integer',
        unsigned: true,
        primary: 3
      },
      {
        name: 'snapshotMembership',
        type: 'integer',
        unsigned: true,
        primary: 0
      }
    ]
  return [
    { name: 'snapshotTableId', type: 'integer', primary: 1 },
    { name: 'started', type: 'boolean', primary: 0 },
    { name: 'afterFieldName', type: 'varchar(100)', primary: 0 },
    { name: 'afterCertificateId', type: 'integer', unsigned: true, primary: 0 },
    { name: 'complete', type: 'boolean', primary: 0 }
  ]
}
async function sqliteIndex(k: Knex, name: string, columns: string[], text: TextDefinition): Promise<boolean> {
  const rows: Array<{ name: string; desc: number; coll: string; key: number }> = await k.raw('PRAGMA index_xinfo(??)', [
    name
  ])
  const parts = rows.filter(row => row.key === 1)
  return (
    parts.length === columns.length &&
    parts.every(
      (row, i) =>
        row.name === columns[i] && row.desc === 0 && row.coll === (textColumn(row.name) ? text.collation : 'BINARY')
    )
  )
}

async function sqliteTable(
  k: Knex,
  table: string,
  keys: boolean,
  secondary: boolean,
  text: TextDefinition
): Promise<boolean> {
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
  const existing: Array<{
    name: string
    unique: number
    origin: string
    partial: number
  }> = await k.raw('PRAGMA index_list(??)', [table])
  if (existing.some(index => index.unique !== 0 && (index.origin !== 'pk' || index.partial !== 0))) return false
  if (!keys) return true
  const primary = existing.find(index => index.origin === 'pk')
  if (primary === undefined || !(await sqliteIndex(k, primary.name, keyColumns, text))) return false
  if (!secondary) return true
  for (const expectedIndex of indexes) {
    const found = existing.find(index => index.name === expectedIndex.name)
    if (found?.unique !== 0 || found.partial !== 0 || !(await sqliteIndex(k, found.name, expectedIndex.columns, text)))
      return false
  }
  return true
}

async function mysqlTable(
  k: Knex,
  table: string,
  keys: boolean,
  secondary: boolean,
  text: TextDefinition
): Promise<boolean> {
  const [tables]: Array<Array<{ engine: string }>> = await k.raw(
    'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  )
  if (tables.length !== 1 || tables[0]?.engine !== 'InnoDB') return false
  const expected = tableColumns(keys)
  const [columns]: Array<
    Array<{
      name: string
      type: string
      nullable: string
      defaultValue: unknown
      extra: string
      charset: string | null
      collation: string | null
    }>
  > = await k.raw(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table]
  )
  if (
    !Array.isArray(columns) ||
    columns.length !== expected.length ||
    columns.some((column, i) => {
      const field = expected[i]
      const integerType = field.unsigned === true ? 'int unsigned' : 'int'
      const scalarType = field.type === 'boolean' ? 'tinyint' : integerType
      const type = field.type === 'varchar(100)' ? field.type : scalarType
      return (
        column.name !== field.name ||
        (textColumn(column.name) ? column.type : column.type.replaceAll(/\(\d+\)/g, '')) !== type ||
        column.charset !== (textColumn(column.name) ? text.charset : null) ||
        column.collation !== (textColumn(column.name) ? text.collation : null) ||
        column.nullable !== 'NO' ||
        column.defaultValue !== null ||
        column.extra !== ''
      )
    })
  )
    return false
  const [parts]: Array<
    Array<{
      name: string
      columnName: string
      nonUnique: number
      direction: string
      prefix: unknown
    }>
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

async function validateTable(k: Knex, table: string, text: TextDefinition, secondary = true): Promise<void> {
  const valid = mysql(k)
    ? await mysqlTable(k, table, table === KEYS, secondary, text)
    : await sqliteTable(k, table, table === KEYS, secondary, text)
  if (!valid) throw new WERR_INVALID_OPERATION('Snapshot certificate table definition mismatch')
}

async function ensureTables(k: Knex, text: TextDefinition): Promise<void> {
  if (!(await k.schema.hasTable(KEYS))) {
    await k.schema.createTable(KEYS, t => {
      if (mysql(k)) void t.engine('InnoDB')
      t.integer('snapshotUserId').unsigned().notNullable()
      t.specificType('snapshotFieldName', fieldType(text)).notNullable()
      t.integer('snapshotCertificateId').unsigned().notNullable()
      t.integer('snapshotMembership').unsigned().notNullable()
      t.primary(keyColumns)
    })
  }
  // MySQL DDL commits independently. Resume an interrupted creation between
  // the table and either auxiliary index without trusting a conflicting index.
  await validateTable(k, KEYS, text, false)
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
  await validateTable(k, KEYS, text)
  if (!(await k.schema.hasTable(PROGRESS))) {
    await k.schema.createTable(PROGRESS, t => {
      if (mysql(k)) void t.engine('InnoDB')
      t.integer('snapshotTableId').primary()
      t.boolean('started').notNullable()
      t.specificType('afterFieldName', fieldType(text)).notNullable()
      t.integer('afterCertificateId').unsigned().notNullable()
      t.boolean('complete').notNullable()
    })
  }
  await validateTable(k, PROGRESS, text)
}

interface Position {
  started: boolean | number
  afterFieldName: string
  afterCertificateId: number
  complete: boolean | number
}
function validPosition(state: Position | undefined): state is Position {
  return (
    state !== undefined &&
    [false, true, 0, 1].includes(state.started) &&
    typeof state.afterFieldName === 'string' &&
    Array.from(state.afterFieldName).length <= 100 &&
    Number.isSafeInteger(state.afterCertificateId) &&
    state.afterCertificateId >= 0 &&
    [false, true, 0, 1].includes(state.complete) &&
    (state.started === true || state.started === 1
      ? state.afterCertificateId > 0
      : state.afterCertificateId === 0 && state.afterFieldName === '')
  )
}
function positive(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1)
    throw new WERR_INVALID_OPERATION('Invalid snapshot certificate source key')
  return value
}
function validateSourceRow(row: { userId: number; fieldName: string; certificateId: number }): void {
  positive(row.userId)
  positive(row.certificateId)
  if (typeof row.fieldName !== 'string' || Array.from(row.fieldName).length > 100)
    throw new WERR_INVALID_OPERATION('Invalid snapshot certificate source key')
}
async function bootstrapPage(k: Knex): Promise<boolean> {
  return await k.transaction(async trx => {
    if (!mysql(k))
      await trx(PROGRESS)
        .where('snapshotTableId', 0)
        .update({ started: trx.ref('started') })
    const progress = trx(PROGRESS).where('snapshotTableId', 0)
    if (mysql(k)) void progress.forUpdate()
    const state: Position | undefined = await progress.first()
    if (!validPosition(state)) throw new WERR_INVALID_OPERATION('Invalid snapshot certificate bootstrap position')
    if (state.complete === true || state.complete === 1) return true
    const source = trx('certificate_fields')
      .select('userId', 'fieldName', 'certificateId')
      .orderBy(['fieldName', 'certificateId'])
      .limit(PAGE_ROWS)
    if (mysql(k)) void source.forUpdate()
    if (state.started === true || state.started === 1) {
      if (mysql(k))
        void source.whereRaw('(fieldName > ? OR (fieldName = ? AND certificateId > ?))', [
          state.afterFieldName,
          state.afterFieldName,
          state.afterCertificateId
        ])
      else void source.whereRaw('(fieldName, certificateId) > (?, ?)', [state.afterFieldName, state.afterCertificateId])
    }
    const rows: Array<{
      userId: number
      fieldName: string
      certificateId: number
    }> = await source
    rows.forEach(validateSourceRow)
    if (rows.length !== 0) {
      const parentQuery = trx('certificates')
        .select('certificateId', 'userId')
        .whereIn(
          'certificateId',
          [...new Set(rows.map(row => row.certificateId))].sort((a, b) => a - b)
        )
        .orderBy('certificateId')
      if (mysql(k)) void parentQuery.forShare()
      const parents: Array<{ certificateId: number; userId: number }> = await parentQuery
      const owners = new Map(parents.map(row => [positive(row.certificateId), positive(row.userId)]))
      await runInSeries([1, 2], async bit => {
        const memberships = rows.flatMap(row => {
          const owner = bit === 1 ? row.userId : owners.get(row.certificateId)
          return owner === undefined
            ? []
            : [
                {
                  snapshotUserId: owner,
                  snapshotFieldName: row.fieldName,
                  snapshotCertificateId: row.certificateId,
                  snapshotMembership: bit
                }
              ]
        })
        if (memberships.length !== 0)
          await trx(KEYS)
            .insert(memberships)
            .onConflict(keyColumns)
            .merge({
              snapshotMembership: trx.raw('?? | ?', ['snapshotMembership', bit])
            })
      })
    }
    const last = rows.at(-1),
      complete = rows.length < PAGE_ROWS
    await trx(PROGRESS)
      .where('snapshotTableId', 0)
      .update({
        started: last === undefined ? state.started : true,
        afterFieldName: last?.fieldName ?? state.afterFieldName,
        afterCertificateId: last?.certificateId ?? state.afterCertificateId,
        complete
      })
    return complete
  })
}
export async function addSnapshotCertificateIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION(
      'Snapshot certificate migration requires independent DDL and bootstrap transactions'
    )
  const text = await sourceText(k)
  await ensureTables(k, text)
  const { observers, producers } = snapshotCertificateIndexTriggers(mysql(k))
  await runInSeries([...observers, ...producers], async expected => {
    if (!(await validateTrigger(k, expected))) await k.raw(expected.sql)
  })
  await k(PROGRESS)
    .insert({
      snapshotTableId: 0,
      started: false,
      afterFieldName: '',
      afterCertificateId: 0,
      complete: false
    })
    .onConflict('snapshotTableId')
    .ignore()
  let complete = false
  function* unfinishedPages() {
    while (!complete) yield undefined
  }
  await runInSeries(unfinishedPages(), async () => {
    complete = await bootstrapPage(k)
  })
}
/** Readers must be drained before removal; source rows and indexes stay intact. */
export async function removeSnapshotCertificateIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION(
      'Snapshot certificate migration requires independent DDL and bootstrap transactions'
    )
  const text = await sourceText(k)
  if (await k.schema.hasTable(KEYS)) await validateTable(k, KEYS, text)
  if (await k.schema.hasTable(PROGRESS)) await validateTable(k, PROGRESS, text)
  const { observers, producers } = snapshotCertificateIndexTriggers(mysql(k)),
    ordered = [...producers, ...observers]
  await runInSeries(ordered, async expected => {
    await validateTrigger(k, expected)
  })
  await runInSeries(ordered, async expected => {
    await k.raw('DROP TRIGGER IF EXISTS ??', [expected.name])
  })
  await k.schema.dropTableIfExists(PROGRESS)
  await k.schema.dropTableIfExists(KEYS)
}
/** Resolve adoption inside the same retained view as the source header/pages. */
export async function readSnapshotCertificateIndexState(k: Knex, config?: Knex.MigratorConfig): Promise<boolean> {
  const tableName = config?.tableName ?? 'knex_migrations',
    schema = k.schema
  if (config?.schemaName !== undefined) void schema.withSchema(config.schemaName)
  if (!(await schema.hasTable(tableName))) return false
  const journal = k(tableName).where('name', SNAPSHOT_CERTIFICATE_INDEX_MIGRATION)
  if (config?.schemaName !== undefined) void journal.withSchema(config.schemaName)
  if ((await journal.first('name')) === undefined) return false
  if (!(await k.schema.hasTable(KEYS)) || !(await k.schema.hasTable(PROGRESS)))
    throw new WERR_INVALID_OPERATION('Snapshot certificate index migration is incomplete')
  const text = await sourceText(k)
  await validateTable(k, KEYS, text)
  await validateTable(k, PROGRESS, text)
  const states: Array<Position & { snapshotTableId: number }> = await k(PROGRESS).select('*').limit(2)
  if (
    states.length !== 1 ||
    states[0]?.snapshotTableId !== 0 ||
    !validPosition(states[0]) ||
    (states[0].complete !== true && states[0].complete !== 1)
  )
    throw new WERR_INVALID_OPERATION('Snapshot certificate index migration is incomplete')
  return true
}
