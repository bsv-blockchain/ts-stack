import { knex, type Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import {
  addSnapshotProfileIndexes,
  removeSnapshotProfileIndexes,
  snapshotProfileTables,
  readSnapshotProfileIndexState,
  SNAPSHOT_PROFILE_INDEX_MIGRATION
} from '../schema/snapshotProfileIndexMigration'

const databases: Knex[] = []
async function minimal(): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  databases.push(k)
  await runInSeries(snapshotProfileTables, async ({ table, key }) => {
    await k.schema.createTable(table, columns => {
      columns.integer(key).primary()
      columns.integer('userId').notNullable()
      columns.text('value')
    })
  })
  return k
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(databases.splice(0), k => k.destroy())
})

test('bootstrap checkpoints exactly256rows and a failed next page resumes without losing independent low-ID writes', async () => {
  const k = await minimal()
  await runInSeries([0, 1, 2], async batch => {
    await k('transactions').insert(
      Array.from({ length: 200 }, (_, offset) => ({
        transactionId: batch * 200 + offset + 1,
        userId: 1,
        value: 'original'
      }))
    )
  })
  let reads = 0
  const failure = new Error('synthetic second page interruption')
  const interrupt = (query: { sql: string }): void => {
    if (query.sql.startsWith('select `transactionId`, `userId` from `transactions`') && ++reads === 2) throw failure
  }
  k.on('query', interrupt)
  try {
    await expect(addSnapshotProfileIndexes(k)).rejects.toBe(failure)
  } finally {
    k.off('query', interrupt)
  }
  expect(await k('snapshot_profile_index_progress').where('snapshotTableId', 0).first()).toEqual({
    snapshotTableId: 0,
    afterRowId: 256,
    complete: 0
  })
  expect(await k('snapshot_profile_keys')).toHaveLength(256)
  await k('transactions').where('transactionId', 1).update({ userId: 2 })
  await k('transactions').where('transactionId', 2).delete()
  await k('transactions').insert({ transactionId: 2, userId: 3, value: 'reinserted' })
  await addSnapshotProfileIndexes(k)
  await addSnapshotProfileIndexes(k)
  expect(await k('snapshot_profile_keys').orderBy('snapshotRowId')).toEqual(
    (await k('transactions').orderBy('transactionId')).map(row => ({
      snapshotTableId: 0,
      snapshotUserId: row.userId,
      snapshotRowId: row.transactionId
    }))
  )
  expect(await k('snapshot_profile_index_progress').where('complete', 1)).toHaveLength(8)
})

test.each([0, 1, 255, 256, 257])('bootstrap preserves its exact final key for a source with %p rows', async count => {
  const k = await minimal()
  if (count > 0)
    await k('tx_labels').insert(Array.from({ length: count }, (_, index) => ({ txLabelId: index + 1, userId: 1 })))
  await addSnapshotProfileIndexes(k)
  expect(await k('snapshot_profile_keys')).toHaveLength(count)
  expect(await k('snapshot_profile_index_progress').where('snapshotTableId', 3).first()).toEqual({
    snapshotTableId: 3,
    afterRowId: count,
    complete: 1
  })
})

test('mismatched source triggers refuse both adoption and removal without deleting the foreign definition', async () => {
  const k = await minimal()
  await addSnapshotProfileIndexes(k)
  await k.raw('DROP TRIGGER snapshot_profile_0_delete')
  const sql = 'CREATE TRIGGER snapshot_profile_0_delete AFTER DELETE ON transactions BEGIN SELECT 1; END'
  await k.raw(sql)
  await expect(addSnapshotProfileIndexes(k)).rejects.toThrow('trigger definition mismatch')
  await expect(removeSnapshotProfileIndexes(k)).rejects.toThrow('trigger definition mismatch')
  expect(await k('sqlite_master').where({ type: 'trigger', name: 'snapshot_profile_0_delete' }).first('sql')).toEqual({
    sql
  })
  expect(await k.schema.hasTable('snapshot_profile_keys')).toBe(true)
})

test('removing auxiliary state twice preserves every standard table/index definition and row', async () => {
  const k = await minimal()
  await k('transactions').insert({ transactionId: 5, userId: 2, value: 'preserved' })
  const definitions = async () =>
    await k('sqlite_master')
      .whereIn('type', ['table', 'index'])
      .select('type', 'name', 'tbl_name', 'sql')
      .orderBy('name')
  const before = await definitions()
  await addSnapshotProfileIndexes(k)
  await removeSnapshotProfileIndexes(k)
  await removeSnapshotProfileIndexes(k)
  expect(await definitions()).toEqual(before)
  expect(await k('transactions')).toEqual([{ transactionId: 5, userId: 2, value: 'preserved' }])
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
})

test('a wrong auxiliary primary key rejects before installing triggers or marking bootstrap complete', async () => {
  const k = await minimal()
  await k.schema.createTable('snapshot_profile_keys', columns => {
    columns.integer('snapshotTableId').notNullable()
    columns.integer('snapshotUserId').notNullable()
    columns.integer('snapshotRowId').notNullable()
    columns.primary(['snapshotUserId', 'snapshotRowId'])
  })
  await expect(addSnapshotProfileIndexes(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
  expect(await k('snapshot_profile_keys')).toEqual([])
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
  expect(await k.schema.hasTable('snapshot_profile_index_progress')).toBe(false)
})

test('only an exact journaled migration with every completed table position selects the indexed path', async () => {
  const k = await minimal()
  expect(await readSnapshotProfileIndexState(k)).toBe(false)
  await addSnapshotProfileIndexes(k)
  expect(await readSnapshotProfileIndexState(k)).toBe(false)
  await k.schema.createTable('custom_journal', columns => {
    columns.increments('id')
    columns.string('name').notNullable()
  })
  const config = { tableName: 'custom_journal', schemaName: 'main' }
  await k('custom_journal').insert({ name: 'future unrelated migration' })
  expect(await readSnapshotProfileIndexState(k, config)).toBe(false)
  await k('custom_journal').insert({ name: SNAPSHOT_PROFILE_INDEX_MIGRATION })
  expect(await readSnapshotProfileIndexState(k, config)).toBe(true)
  await k('snapshot_profile_index_progress').where('snapshotTableId', 3).update({ complete: 0 })
  await expect(readSnapshotProfileIndexState(k, config)).rejects.toThrow('migration is incomplete')
  await k('snapshot_profile_index_progress').where('snapshotTableId', 3).update({ complete: 1, afterRowId: -1 })
  await expect(readSnapshotProfileIndexState(k, config)).rejects.toThrow('migration is incomplete')
  await k('snapshot_profile_index_progress').where('snapshotTableId', 3).delete()
  await expect(readSnapshotProfileIndexState(k, config)).rejects.toThrow('migration is incomplete')
})

test.each([
  [
    'missing column',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId, snapshotUserId))'
  ],
  [
    'wrong type',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId TEXT NOT NULL, snapshotUserId INTEGER NOT NULL, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId, snapshotUserId, snapshotRowId))'
  ],
  [
    'nullable owner',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId, snapshotUserId, snapshotRowId))'
  ],
  [
    'unexpected default',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL DEFAULT 0, snapshotUserId INTEGER NOT NULL, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId, snapshotUserId, snapshotRowId))'
  ],
  [
    'reordered primary key',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER NOT NULL, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotUserId, snapshotTableId, snapshotRowId))'
  ],
  [
    'extra unique constraint',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER NOT NULL UNIQUE, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId, snapshotUserId, snapshotRowId))'
  ],
  [
    'descending key',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER NOT NULL, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId DESC, snapshotUserId, snapshotRowId))'
  ],
  [
    'different collation',
    'CREATE TABLE snapshot_profile_keys (snapshotTableId INTEGER NOT NULL, snapshotUserId INTEGER NOT NULL, snapshotRowId INTEGER NOT NULL, PRIMARY KEY(snapshotTableId COLLATE NOCASE, snapshotUserId, snapshotRowId))'
  ]
])('auxiliary %s schema cannot be adopted or deleted', async (_name, sql) => {
  const k = await minimal()
  await k.raw(sql)
  await expect(addSnapshotProfileIndexes(k)).rejects.toThrow('table definition mismatch')
  await expect(removeSnapshotProfileIndexes(k)).rejects.toThrow('table definition mismatch')
  expect(await k('sqlite_master').where({ type: 'table', name: 'snapshot_profile_keys' }).first('sql')).toEqual({ sql })
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
})

test.each([
  { afterRowId: -1 },
  { afterRowId: 1.5 },
  { afterRowId: 'invalid' },
  { afterRowId: Number.MAX_SAFE_INTEGER + 1 },
  { complete: 2 },
  { complete: 'invalid' }
])('malformed bootstrap progress %j refuses before source reads', async change => {
  const k = await minimal()
  await addSnapshotProfileIndexes(k)
  await k('snapshot_profile_index_progress')
    .where('snapshotTableId', 0)
    .update({ complete: 0, ...change })
  const queries: string[] = []
  const listen = (query: { sql: string }): void => {
    queries.push(query.sql)
  }
  k.on('query', listen)
  try {
    await expect(addSnapshotProfileIndexes(k)).rejects.toThrow('bootstrap position')
  } finally {
    k.off('query', listen)
  }
  expect(queries.some(sql => sql.startsWith('select `transactionId`, `userId` from `transactions`'))).toBe(false)
  expect(await k('snapshot_profile_keys')).toEqual([])
})

test.each([0, -1, 1.5, 'invalid', Number.MAX_SAFE_INTEGER + 1])(
  'source profile key %p refuses before a bootstrap checkpoint can be completed',
  async userId => {
    const k = await minimal()
    await k('transactions').insert({ transactionId: 1, userId })
    await expect(addSnapshotProfileIndexes(k)).rejects.toThrow('source key')
    expect(await k('snapshot_profile_keys')).toEqual([])
    expect(await k('snapshot_profile_index_progress').where('snapshotTableId', 0).first()).toEqual({
      snapshotTableId: 0,
      afterRowId: 0,
      complete: 0
    })
  }
)

test('journaled missing key/progress tables refuse rather than presenting an empty wallet', async () => {
  const k = await minimal()
  await k.schema.createTable('knex_migrations', columns => {
    columns.string('name')
  })
  await k('knex_migrations').insert({ name: SNAPSHOT_PROFILE_INDEX_MIGRATION })
  await expect(readSnapshotProfileIndexState(k)).rejects.toThrow('migration is incomplete')
  await addSnapshotProfileIndexes(k)
  await k.schema.dropTable('snapshot_profile_index_progress')
  await expect(readSnapshotProfileIndexState(k)).rejects.toThrow('migration is incomplete')
})

test('incomplete SQLite primary-index metadata refuses before any bootstrap or trigger is installed', async () => {
  const k = await minimal()
  let omitted = false
  const omitIndexMetadata = (rows: unknown, query: { sql: string }): void => {
    if (query.sql.startsWith('PRAGMA index_list(') && query.sql.includes('snapshot_profile_keys')) {
      expect(Array.isArray(rows)).toBe(true)
      ;(rows as unknown[]).splice(0)
      omitted = true
    }
  }
  k.on('query-response', omitIndexMetadata)
  try {
    await expect(addSnapshotProfileIndexes(k)).rejects.toThrow('table definition mismatch')
  } finally {
    k.off('query-response', omitIndexMetadata)
  }
  expect(omitted).toBe(true)
  expect(await k.schema.hasTable('snapshot_profile_index_progress')).toBe(false)
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
})
