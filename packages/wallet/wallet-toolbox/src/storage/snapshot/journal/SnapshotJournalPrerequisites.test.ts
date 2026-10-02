import {
  readSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} from './SnapshotJournalSqliteGeneration'
import { knex, type Knex } from 'knex'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { readSnapshotJournalHighWater } from './SnapshotJournalHighWater'
import { snapshotJournalSqliteObserverSql } from './SnapshotJournalSqliteObservers'
import { snapshotJournalMysqlObserverSql } from './SnapshotJournalMysqlObservers'
import { snapshotJournalRevision as rev } from './SnapshotJournalRevision'

test.each([
  ['bootstrap', (k: Knex) => copySnapshotJournalBootstrapPage(k, 1000000)],
  ['SQLite generation read', (k: Knex) => readSnapshotJournalSqliteGeneration(k)],
  ['SQLite generation completion', (k: Knex) => completeSnapshotJournalSqliteGeneration(k)],
  ['high-water', (k: Knex) => readSnapshotJournalHighWater(k, 1, rev('0'), rev('0'))],
  ['SQLite observers', (k: Knex) => snapshotJournalSqliteObserverSql(k)],
  ['MySQL observers', (k: Knex) => snapshotJournalMysqlObserverSql(k)]
] as const)('%s rejects an unsupported driver before I/O', async (_name, run) => {
  const k = knex({ client: 'mysql2' }),
    query = jest.fn()
  k.client.config.client = 'unsupported'
  k.on('query', query)
  try {
    await expect(run(k)).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  } finally {
    await k.destroy()
  }
})
test('SQLite observer preparation refuses a missing source without any schema writes', async () => {
  const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }),
    queries: string[] = []
  k.on('query', q => queries.push(q.sql))
  try {
    await expect(snapshotJournalSqliteObserverSql(k)).rejects.toThrow('Missing snapshot journal source')
    expect(queries).toEqual(['PRAGMA table_info(`transactions`)'])
    expect(await k('sqlite_master').select('name')).toEqual([])
  } finally {
    await k.destroy()
  }
})
test('MySQL observer preparation refuses missing driver metadata without emitting DDL', async () => {
  const raw = jest.fn(async () => [[]]),
    k = { client: { config: { client: 'mysql2' } }, raw } as unknown as Knex
  await expect(snapshotJournalMysqlObserverSql(k)).rejects.toThrow('Missing snapshot journal source')
  expect(raw).toHaveBeenCalledTimes(1)
})
