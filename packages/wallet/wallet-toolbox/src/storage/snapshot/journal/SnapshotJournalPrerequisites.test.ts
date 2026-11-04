import {
  readSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} from './SnapshotJournalSqliteGeneration'
import { knex, type Knex } from 'knex'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { readSnapshotJournalHighWater } from './SnapshotJournalHighWater'
import { snapshotJournalSqliteObserverSql, snapshotJournalSqliteSources } from './SnapshotJournalSqliteObservers'
import { snapshotJournalMysqlObserverSql } from './SnapshotJournalMysqlObservers'
import { snapshotJournalRevision as rev } from './SnapshotJournalRevision'

const journalReceiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 2592000000 }

test.each([
  ['bootstrap', (k: Knex) => copySnapshotJournalBootstrapPage(k, 1000000)],
  ['SQLite generation read', (k: Knex) => readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)],
  ['SQLite generation completion', (k: Knex) => completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)],
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
test.each(['better-sqlite3', 'sqlite3'] as const)(
  '%s observer preparation refuses a missing source without any schema writes',
  async driver => {
    const k = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
      }),
      queries: Array<{ sql: string; bindings: unknown[] }> = []
    k.client.config.client = driver
    k.on('query', q => queries.push({ sql: q.sql, bindings: q.bindings }))
    try {
      await expect(snapshotJournalSqliteObserverSql(k)).rejects.toThrow('Missing snapshot journal source')
      expect(queries).toHaveLength(1)
      if (driver === 'better-sqlite3') {
        expect(queries[0].sql).toMatch(/^SELECT /)
        expect(queries[0].sql).toContain('CROSS JOIN pragma_table_info(s.name)')
        expect(queries[0].bindings).toEqual(snapshotJournalSqliteSources)
      } else {
        expect(queries[0].sql).toBe('PRAGMA table_info(`transactions`)')
      }
      expect(await k('sqlite_master').select('name')).toEqual([])
    } finally {
      await k.destroy()
    }
  }
)
test('MySQL observer preparation refuses missing driver metadata without emitting DDL', async () => {
  const raw = jest.fn(async () => [[]]),
    k = { client: { config: { client: 'mysql2' } }, raw } as unknown as Knex
  await expect(snapshotJournalMysqlObserverSql(k)).rejects.toThrow('Missing snapshot journal source')
  expect(raw).toHaveBeenCalledTimes(1)
})
