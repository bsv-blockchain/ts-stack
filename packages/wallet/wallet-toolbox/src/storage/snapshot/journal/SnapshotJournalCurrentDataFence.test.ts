import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSnapshotJournalCurrentDataFence } from './SnapshotJournalCurrentDataFence'
import { SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL } from './SnapshotJournalSqliteObservers'
import { snapshotJournalRevision } from './SnapshotJournalRevision'

jest.setTimeout(30000)
let directory: string, db: Knex, other: Knex
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-data-cutover-'))
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  db = knex(config)
  other = knex(config)
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw('PRAGMA busy_timeout = 0')
  await other.raw('PRAGMA busy_timeout = 0')
  await db.raw('CREATE TABLE users(userId INTEGER PRIMARY KEY,activeStorage TEXT)')
  await db('users').insert({ userId: 1, activeStorage: 'source' })
  for (const sql of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await db.raw(sql)
})
afterEach(async () => {
  await other.destroy()
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})
const revision = snapshotJournalRevision
const scope = { tableId: 4, userId: 1, id1: 1, id2: 0, exactText: '', present: 1 }

test('a later scoped write refuses activation while equal and foreign-profile positions do not', async () => {
  await db('snapshot_journal_scope').insert([
    { ...scope, revision: 10 },
    { ...scope, userId: 2, revision: 11 }
  ])
  const commit = jest.fn(async () => 7)
  expect(
    await db.transaction(
      async trx =>
        await withSnapshotJournalCurrentDataFence(
          trx,
          1,
          revision('10'),
          revision('1000'),
          async () => undefined,
          commit
        )
    )
  ).toEqual({ current: true, value: 7 })
  await db('snapshot_journal_scope').where(scope).update({ revision: 11 })
  commit.mockClear()
  expect(
    await db.transaction(
      async trx =>
        await withSnapshotJournalCurrentDataFence(
          trx,
          1,
          revision('10'),
          revision('1000'),
          async () => undefined,
          commit
        )
    )
  ).toEqual({ current: false })
  expect(commit).not.toHaveBeenCalled()
})

test.each([8, 9])('a physical global change after the fresh view prevents table %s cutover', async tableId => {
  await db('snapshot_journal_physical').insert({
    tableId,
    id1: 1,
    id2: 0,
    exactText: '',
    revision: 11,
    generation: 1,
    present: 1
  })
  const commit = jest.fn(async () => undefined)
  expect(
    await db.transaction(
      async trx =>
        await withSnapshotJournalCurrentDataFence(
          trx,
          1,
          revision('10'),
          revision('1000'),
          async () => undefined,
          commit
        )
    )
  ).toEqual({ current: false })
  expect(commit).not.toHaveBeenCalled()
})

test('the data fence keeps physical writer exclusion through the actual destination callback', async () => {
  await db.transaction(async trx => {
    expect(
      await withSnapshotJournalCurrentDataFence(
        trx,
        1,
        revision('10'),
        revision('1000'),
        async () => undefined,
        async () => {
          await expect(other('snapshot_journal_scope').insert({ ...scope, revision: 11 })).rejects.toThrow()
          return 'closed destination'
        }
      )
    ).toEqual({ current: true, value: 'closed destination' })
    await trx.rollback()
  })
  await other('snapshot_journal_scope').insert({ ...scope, revision: 11 })
  expect(await other('snapshot_journal_scope').count('* AS n').first()).toEqual({ n: 1 })
})
