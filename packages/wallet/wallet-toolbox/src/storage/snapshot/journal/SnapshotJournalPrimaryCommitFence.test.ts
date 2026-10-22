import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSnapshotJournalPrimaryCommitFence } from './SnapshotJournalPrimaryCommitFence'

jest.setTimeout(30000)
let directory: string, db: Knex, other: Knex
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-primary-commit-'))
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
})
afterEach(async () => {
  await other.destroy()
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})

test('primary changes fail immediately during one commit and succeed after fence rollback', async () => {
  await db.transaction(async trx => {
    await withSnapshotJournalPrimaryCommitFence(
      trx,
      1,
      async () => {
        expect((await trx('users').first()).activeStorage).toBe('source')
      },
      async () => {
        await expect(other('users').where({ userId: 1 }).update({ activeStorage: 'replacement' })).rejects.toThrow()
        expect((await other('users').first()).activeStorage).toBe('source')
      }
    )
    await trx.rollback()
  })
  expect(await other('users').where({ userId: 1 }).update({ activeStorage: 'replacement' })).toBe(1)
})

test('fresh authority rejection prevents the destination callback', async () => {
  const commit = jest.fn(async () => undefined)
  await expect(
    db.transaction(
      async trx =>
        await withSnapshotJournalPrimaryCommitFence(
          trx,
          1,
          async () => {
            throw new Error('ordinary source generation changed')
          },
          commit
        )
    )
  ).rejects.toThrow('ordinary source generation changed')
  expect(commit).not.toHaveBeenCalled()
  expect(await other('users').where({ userId: 1 }).update({ activeStorage: 'replacement' })).toBe(1)
})

test('a busy source refuses before verification or destination admission', async () => {
  const held = await other.transaction()
  try {
    await held('users').where({ userId: 1 }).update({ activeStorage: 'replacement' })
    const verify = jest.fn(async () => undefined),
      commit = jest.fn(async () => undefined)
    await expect(
      db.transaction(async trx => await withSnapshotJournalPrimaryCommitFence(trx, 1, verify, commit))
    ).rejects.toThrow()
    expect(verify).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  } finally {
    await held.rollback()
    await held.executionPromise
  }
})

test('missing profile and unsupported SQLite mode cannot obtain a commit fence', async () => {
  const commit = jest.fn(async () => undefined)
  await expect(
    db.transaction(async trx => await withSnapshotJournalPrimaryCommitFence(trx, 2, async () => undefined, commit))
  ).rejects.toThrow('primary commit fence')
  await db.raw('PRAGMA busy_timeout = 1')
  await expect(
    db.transaction(async trx => await withSnapshotJournalPrimaryCommitFence(trx, 1, async () => undefined, commit))
  ).rejects.toThrow('primary commit fence')
  expect(commit).not.toHaveBeenCalled()
})
