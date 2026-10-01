import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const SNAPSHOT_PROFILE_INDEX_MIGRATION = '2026-10-01-003 add snapshot profile key indexes'

export const snapshotProfileTables = [
  { table: 'transactions', key: 'transactionId' },
  { table: 'outputs', key: 'outputId' },
  { table: 'certificates', key: 'certificateId' },
  { table: 'tx_labels', key: 'txLabelId' },
  { table: 'output_baskets', key: 'basketId' },
  { table: 'output_tags', key: 'outputTagId' },
  { table: 'commissions', key: 'commissionId' },
  { table: 'sync_states', key: 'syncStateId' }
] as const

const KEYS = 'snapshot_profile_keys'
const PROGRESS = 'snapshot_profile_index_progress'
const PAGE_ROWS = 256

function isMySQL(k: Knex): boolean {
  return String(k.client.config.client).includes('mysql')
}

function normalized(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/ IF NOT EXISTS /g, ' ')
    .trim()
}

async function validateTable(k: Knex, table: string): Promise<void> {
  const keys = table === KEYS
  const names = keys
    ? ['snapshotTableId', 'snapshotUserId', 'snapshotRowId']
    : ['snapshotTableId', 'afterRowId', 'complete']
  const primary = keys ? names : ['snapshotTableId']
  let valid: boolean
  if (isMySQL(k)) {
    const [columns]: Array<
      Array<{ name: string; type: string; nullable: string; defaultValue: unknown; extra: string }>
    > = await k.raw(
      'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table]
    )
    const [indexes]: Array<
      Array<{ name: string; columnName: string; nonUnique: number; direction: string; prefix: unknown }>
    > = await k.raw(
      'SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, COLLATION AS direction, SUB_PART AS prefix FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [table]
    )
    const types = keys ? ['int', 'int unsigned', 'int unsigned'] : ['int', 'int unsigned', 'tinyint']
    valid =
      Array.isArray(columns) &&
      columns.length === names.length &&
      columns.every(
        (column, i) =>
          column.name === names[i] &&
          column.type.replace(/\(\d+\)/g, '') === types[i] &&
          column.nullable === 'NO' &&
          column.defaultValue === null &&
          column.extra === ''
      ) &&
      Array.isArray(indexes) &&
      indexes.every(index =>
        index.name === 'PRIMARY' ? index.direction === 'A' && index.prefix === null : Number(index.nonUnique) === 1
      ) &&
      JSON.stringify(indexes.filter(index => index.name === 'PRIMARY').map(index => index.columnName)) ===
        JSON.stringify(primary)
  } else {
    const columns: Array<{
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
      hidden: number
    }> = await k.raw('PRAGMA table_xinfo(??)', [table])
    const indexes: Array<{ name: string; unique: number; origin: string; partial: number }> = await k.raw(
      'PRAGMA index_list(??)',
      [table]
    )
    const expectedPk = keys ? [1, 2, 3] : [1, 0, 0]
    const nullable = keys ? [1, 1, 1] : [0, 1, 1]
    const types = keys ? ['integer', 'integer', 'integer'] : ['integer', 'integer', 'boolean']
    valid =
      Array.isArray(columns) &&
      columns.length === names.length &&
      columns.every(
        (column, i) =>
          column.name === names[i] &&
          column.type.toLowerCase() === types[i] &&
          column.notnull === nullable[i] &&
          column.dflt_value === null &&
          column.pk === expectedPk[i] &&
          column.hidden === 0
      ) &&
      Array.isArray(indexes) &&
      indexes.every(index => index.unique === 0 || (index.origin === 'pk' && index.partial === 0))
    const pk = indexes.find(index => index.origin === 'pk')
    if (valid && keys) {
      if (pk === undefined) valid = false
      else {
        const parts: Array<{ name: string; desc: number; coll: string; key: number }> = await k.raw(
          'PRAGMA index_xinfo(??)',
          [pk.name]
        )
        const indexed = parts.filter(part => part.key === 1)
        valid =
          indexed.length === names.length &&
          indexed.every((part, i) => part.name === names[i] && part.desc === 0 && part.coll === 'BINARY')
      }
    }
  }
  if (!valid) throw new WERR_INVALID_OPERATION('Snapshot profile table definition mismatch')
}

async function installTrigger(
  k: Knex,
  table: string,
  key: string,
  tableId: number,
  event: 'DELETE' | 'UPDATE' | 'INSERT',
  create = true
): Promise<void> {
  const name = `snapshot_profile_${tableId}_${event.toLowerCase()}`
  const remove = `DELETE FROM ${KEYS} WHERE snapshotTableId = ${tableId} AND snapshotUserId = OLD.userId AND snapshotRowId = OLD.${key};`
  const add = `INSERT INTO ${KEYS} (snapshotTableId, snapshotUserId, snapshotRowId) VALUES (${tableId}, NEW.userId, NEW.${key});`
  const mysql = isMySQL(k)
  const changed = mysql
    ? `NOT (OLD.userId <=> NEW.userId) OR NOT (OLD.${key} <=> NEW.${key})`
    : `OLD.userId IS NOT NEW.userId OR OLD.${key} IS NOT NEW.${key}`
  const statements = event === 'DELETE' ? remove : event === 'INSERT' ? add : remove + ' ' + add
  const body =
    mysql && event === 'UPDATE' ? `BEGIN IF ${changed} THEN ${statements} END IF; END` : `BEGIN ${statements} END`
  const qualifier = mysql ? ' FOR EACH ROW' : event === 'UPDATE' ? ` WHEN ${changed}` : ''
  const sql = `CREATE TRIGGER ${name} AFTER ${event} ON ${table}${qualifier} ${body}`
  if (mysql) {
    const [rows]: Array<Array<{ event: string; timing: string; tableName: string; body: string }>> = await k.raw(
      'SELECT EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, EVENT_OBJECT_TABLE AS tableName, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
      [name]
    )
    if (!Array.isArray(rows)) throw new WERR_INVALID_OPERATION('Invalid snapshot profile trigger metadata')
    if (rows.length !== 0) {
      const row = rows[0]
      if (
        rows.length !== 1 ||
        row === undefined ||
        row.event !== event ||
        row.timing !== 'AFTER' ||
        row.tableName !== table ||
        normalized(row.body) !== normalized(body)
      ) {
        throw new WERR_INVALID_OPERATION('Snapshot profile trigger definition mismatch')
      }
      return
    }
  } else {
    const row: { sql: string } | undefined = await k('sqlite_master').where({ type: 'trigger', name }).first('sql')
    if (row !== undefined) {
      if (normalized(row.sql) !== normalized(sql))
        throw new WERR_INVALID_OPERATION('Snapshot profile trigger definition mismatch')
      return
    }
  }
  if (create) await k.raw(sql)
}

async function bootstrapTable(k: Knex, table: string, key: string, tableId: number): Promise<void> {
  await k(PROGRESS)
    .insert({ snapshotTableId: tableId, afterRowId: 0, complete: false })
    .onConflict('snapshotTableId')
    .ignore()
  let complete = false
  while (!complete) {
    complete = await k.transaction(async trx => {
      // SQLite must acquire its writer lock before reading a resumable position.
      // MySQL takes a current row lock without loading an older read-view value.
      if (!isMySQL(k))
        await trx(PROGRESS)
          .where('snapshotTableId', tableId)
          .update({ afterRowId: trx.ref('afterRowId') })
      const query = trx(PROGRESS).where('snapshotTableId', tableId)
      if (isMySQL(k)) void query.forUpdate()
      const state: { afterRowId: number; complete: boolean | number } | undefined = await query.first()
      if (
        state === undefined ||
        !Number.isSafeInteger(state.afterRowId) ||
        state.afterRowId < 0 ||
        ![false, true, 0, 1].includes(state.complete)
      ) {
        throw new WERR_INVALID_OPERATION('Invalid snapshot profile bootstrap position')
      }
      if (state.complete === true || state.complete === 1) return true
      const source = trx(table).select(key, 'userId').where(key, '>', state.afterRowId).orderBy(key).limit(PAGE_ROWS)
      if (isMySQL(k)) void source.forUpdate()
      const rows: Array<Record<string, number>> = await source
      const keys = rows.map(row => {
        const rowId = row[key]
        const userId = row.userId
        if (
          rowId === undefined ||
          userId === undefined ||
          !Number.isSafeInteger(rowId) ||
          rowId < 1 ||
          !Number.isSafeInteger(userId) ||
          userId < 1
        ) {
          throw new WERR_INVALID_OPERATION('Invalid snapshot profile source key')
        }
        return { snapshotTableId: tableId, snapshotUserId: userId, snapshotRowId: rowId }
      })
      if (keys.length !== 0)
        await trx(KEYS).insert(keys).onConflict(['snapshotTableId', 'snapshotUserId', 'snapshotRowId']).ignore()
      const finished = rows.length < PAGE_ROWS
      await trx(PROGRESS)
        .where('snapshotTableId', tableId)
        .update({ afterRowId: keys.at(-1)?.snapshotRowId ?? state.afterRowId, complete: finished })
      return finished
    })
  }
}

/** Add auxiliary keys without altering any standard-table index or OFFSET plan. */
export async function addSnapshotProfileIndexes(k: Knex): Promise<void> {
  if (isMySQL(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION('Snapshot profile migration requires independent DDL and bootstrap transactions')
  if (!(await k.schema.hasTable(KEYS))) {
    await k.schema.createTable(KEYS, t => {
      t.integer('snapshotTableId').notNullable()
      t.integer('snapshotUserId').unsigned().notNullable()
      t.integer('snapshotRowId').unsigned().notNullable()
      t.primary(['snapshotTableId', 'snapshotUserId', 'snapshotRowId'])
    })
  }
  await validateTable(k, KEYS)
  if (!(await k.schema.hasTable(PROGRESS))) {
    await k.schema.createTable(PROGRESS, t => {
      t.integer('snapshotTableId').primary()
      t.integer('afterRowId').unsigned().notNullable()
      t.boolean('complete').notNullable()
    })
  }
  await validateTable(k, PROGRESS)
  for (const [tableId, { table, key }] of snapshotProfileTables.entries()) {
    // Deletion must be observed before any partial installation can add keys.
    await installTrigger(k, table, key, tableId, 'DELETE')
    await installTrigger(k, table, key, tableId, 'UPDATE')
    await installTrigger(k, table, key, tableId, 'INSERT')
    await bootstrapTable(k, table, key, tableId)
  }
}

/** Call only after snapshot readers are drained; standard rows remain intact. */
export async function removeSnapshotProfileIndexes(k: Knex): Promise<void> {
  if (isMySQL(k) && k.isTransaction)
    throw new WERR_INVALID_OPERATION('Snapshot profile migration requires independent DDL and bootstrap transactions')
  if (await k.schema.hasTable(KEYS)) await validateTable(k, KEYS)
  if (await k.schema.hasTable(PROGRESS)) await validateTable(k, PROGRESS)
  for (const [tableId, { table, key }] of snapshotProfileTables.entries()) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const)
      await installTrigger(k, table, key, tableId, event, false)
  }
  for (const [tableId] of snapshotProfileTables.entries()) {
    // Stop every producer before removing the last deletion observer.
    for (const event of ['insert', 'update', 'delete'])
      await k.raw(`DROP TRIGGER IF EXISTS snapshot_profile_${tableId}_${event}`)
  }
  await k.schema.dropTableIfExists(PROGRESS)
  await k.schema.dropTableIfExists(KEYS)
}

/** Read only within the retained view that owns this snapshot's header and pages. */
export async function readSnapshotProfileIndexState(k: Knex, config?: Knex.MigratorConfig): Promise<boolean> {
  const tableName = config?.tableName ?? 'knex_migrations'
  const journalSchema = k.schema
  if (config?.schemaName !== undefined) void journalSchema.withSchema(config.schemaName)
  if (!(await journalSchema.hasTable(tableName))) return false
  const journal = k(tableName).where('name', SNAPSHOT_PROFILE_INDEX_MIGRATION)
  if (config?.schemaName !== undefined) void journal.withSchema(config.schemaName)
  if ((await journal.first('name')) === undefined) return false
  if (!(await k.schema.hasTable(KEYS)) || !(await k.schema.hasTable(PROGRESS))) {
    throw new WERR_INVALID_OPERATION('Snapshot profile index migration is incomplete')
  }
  await validateTable(k, KEYS)
  await validateTable(k, PROGRESS)
  const rows: Array<{ snapshotTableId: number; afterRowId: number; complete: unknown }> = await k(PROGRESS)
    .select('snapshotTableId', 'afterRowId', 'complete')
    .orderBy('snapshotTableId')
    .limit(snapshotProfileTables.length + 1)
  if (
    rows.length !== snapshotProfileTables.length ||
    rows.some(
      (row, index) =>
        row.snapshotTableId !== index ||
        !Number.isSafeInteger(row.afterRowId) ||
        row.afterRowId < 0 ||
        (row.complete !== true && row.complete !== 1)
    )
  )
    throw new WERR_INVALID_OPERATION('Snapshot profile index migration is incomplete')
  return true
}
