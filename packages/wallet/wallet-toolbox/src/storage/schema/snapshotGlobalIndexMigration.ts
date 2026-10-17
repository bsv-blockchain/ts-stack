import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { snapshotGlobalIndexTriggers, type SnapshotGlobalIndexTrigger } from './snapshotGlobalIndexTriggers'
import { tables, PROGRESS, mysql, normalized, invalid, type Table } from './snapshotGlobalIndexModel'
import { mysqlParts, mysqlTable, validateMysqlSource } from './snapshotGlobalIndexMysql'
import { sqliteTable, validateSqliteSource, validateSqliteTables } from './snapshotGlobalIndexSqlite'
import { validPosition, bootstrapPage, type Position } from './snapshotGlobalIndexBootstrap'

export const SNAPSHOT_GLOBAL_INDEX_MIGRATION = '2026-10-01-006 add snapshot global reference indexes'
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
async function validateSource(k: Knex): Promise<void> {
  if (mysql(k)) await validateMysqlSource(k)
  else await validateSqliteSource(k)
}
async function validateGlobalTables(k: Knex): Promise<void> {
  if (!mysql(k)) return await validateSqliteTables(k, tables())
  await runInSeries(tables(), async table => {
    if (!(await k.schema.hasTable(table.name))) invalid('Snapshot global index migration is incomplete')
    await validateTable(k, table)
  })
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
export async function addSnapshotGlobalIndexes(k: Knex): Promise<void> {
  if (mysql(k) && k.isTransaction)
    invalid('Snapshot global migration requires independent DDL and bootstrap transactions')
  await validateSource(k)
  await runInSeries(tables(), async table => {
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
  await runInSeries(tables(), async table => {
    if (await k.schema.hasTable(table.name)) await validateTable(k, table)
  })
  const triggers = snapshotGlobalIndexTriggers(mysql(k)).reverse()
  await runInSeries(triggers, async trigger => {
    await validateTrigger(k, trigger)
  })
  await runInSeries(triggers, async trigger => {
    await k.raw('DROP TRIGGER IF EXISTS ??', [trigger.name])
  })
  await runInSeries([...tables()].reverse(), async table => {
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
  await validateGlobalTables(k)
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
