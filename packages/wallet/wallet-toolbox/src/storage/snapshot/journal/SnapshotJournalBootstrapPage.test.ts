import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshotJournalMetadataPage, type SnapshotJournalInterval } from './SnapshotJournalPage'
import { snapshotJournalRevision } from './SnapshotJournalRevision'

jest.setTimeout(30000)
let db: Knex
let directory: string
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-current-state-page-'))
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode=WAL')
  await db.raw('PRAGMA busy_timeout=0')
  await db.raw(
    'CREATE TABLE snapshot_journal_scope(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT COLLATE BINARY NOT NULL,revision INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,userId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE INDEX snapshot_journal_scope_page ON snapshot_journal_scope(userId,tableId,revision,id1,id2,exactText)'
  )
  await db('snapshot_journal_scope').insert([
    { tableId: 12, userId: 7, id1: 1, id2: 0, exactText: 'A', revision: 1, present: 1 },
    { tableId: 12, userId: 7, id1: 1, id2: 0, exactText: 'a', revision: 1, present: 1 },
    { tableId: 12, userId: 7, id1: 2, id2: 0, exactText: 'removed', revision: 3, present: 0 },
    { tableId: 12, userId: 7, id1: 3, id2: 0, exactText: 'é', revision: 8, present: 1 },
    { tableId: 12, userId: 7, id1: 4, id2: 0, exactText: 'future', revision: 10, present: 1 },
    { tableId: 12, userId: 99, id1: 5, id2: 0, exactText: 'other-user', revision: 2, present: 1 }
  ])
})
afterEach(async () => {
  try {
    await db.destroy()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
function interval(): SnapshotJournalInterval {
  return {
    bootstrap: true,
    stream: 'scope',
    tableId: 12,
    userId: 7,
    floor: snapshotJournalRevision('5'),
    low: snapshotJournalRevision('0'),
    high: snapshotJournalRevision('9'),
    limit: 2
  }
}
test('current-state scan includes older present rows, exact ties and current rows while excluding tombstones/other users/future rows', async () => {
  await db.transaction(async trx => {
    const first = await readSnapshotJournalMetadataPage(trx, interval())
    expect(first.rows.map(row => [row.revision, row.id1, row.exactText, row.present])).toEqual([
      ['1', 1, 'A', true],
      ['1', 1, 'a', true]
    ])
    expect(first.complete).toBe(false)
    const second = await readSnapshotJournalMetadataPage(trx, { ...interval(), after: first.after })
    expect(second.rows.map(row => [row.revision, row.id1, row.exactText, row.present])).toEqual([['8', 3, 'é', true]])
    expect(second.complete).toBe(true)
  })
})
test('a floor gap remains a refusal for incremental history and full scans require the explicit zero lower bound', async () => {
  await expect(
    db.transaction(async trx => await readSnapshotJournalMetadataPage(trx, { ...interval(), bootstrap: undefined }))
  ).rejects.toThrow('Invalid snapshot journal interval')
  await expect(
    db.transaction(
      async trx => await readSnapshotJournalMetadataPage(trx, { ...interval(), low: snapshotJournalRevision('1') })
    )
  ).rejects.toThrow('Invalid snapshot journal interval')
  await expect(
    db.transaction(
      async trx => await readSnapshotJournalMetadataPage(trx, { ...interval(), floor: snapshotJournalRevision('10') })
    )
  ).rejects.toThrow('Invalid snapshot journal interval')
})
test('one pinned full scan remains coherent across independent foreground updates', async () => {
  const writer = knex({
    client: 'better-sqlite3',
    connection: db.client.config.connection,
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    await writer.raw('PRAGMA busy_timeout=0')
    await db.transaction(async trx => {
      const first = await readSnapshotJournalMetadataPage(trx, interval())
      await writer('snapshot_journal_scope')
        .where({ tableId: 12, userId: 7, id1: 3 })
        .update({ present: 0, revision: 11 })
      const second = await readSnapshotJournalMetadataPage(trx, { ...interval(), after: first.after })
      expect(second.rows.map(row => row.id1)).toEqual([3])
      expect(second.rows[0].present).toBe(true)
      expect(second.rows[0].revision).toBe('8')
    })
    expect(
      await writer('snapshot_journal_scope').where({ tableId: 12, userId: 7, id1: 3 }).first('present', 'revision')
    ).toEqual({ present: 0, revision: 11 })
  } finally {
    await writer.destroy()
  }
})
