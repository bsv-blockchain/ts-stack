import { knex, type Knex } from 'knex'
import {
  SNAPSHOT_JOURNAL_SHARED_QUOTA,
  SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
  SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
  snapshotJournalSharedQuotaDdl,
  snapshotJournalSharedQuotaTriggers
} from './SnapshotJournalSharedQuota'

const table = 'snapshot_reconciliation_independent_fixture'
const ddl = `CREATE TABLE ${table}(id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id))`
const charge = (id: number, payload: string): number =>
  4096 + 4 * (Buffer.byteLength(String(id), 'utf8') + Buffer.byteLength(payload, 'utf8'))

async function fixture(work: (database: Knex) => Promise<void>): Promise<void> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await database.raw(snapshotJournalSharedQuotaDdl(database))
    await database.raw(ddl)
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).insert({
      id: 0,
      byteLimit: SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
      rowLimit: SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
      bytes: 0,
      rows: 0,
      changeBit: 0
    })
    for (const trigger of snapshotJournalSharedQuotaTriggers(database, [ddl])) await database.raw(trigger.sql)
    await work(database)
  } finally {
    await database.destroy()
  }
}

test('physical SQLite quota triggers retain independent UTF8 charges across inserts, conflict updates and deletion', async () => {
  await fixture(async database => {
    const counter = async () => await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')
    await database(table).insert({ id: 12, payload: 'é😀' })
    await database(table).insert({ id: -7, payload: '' })
    expect(await counter()).toEqual({ bytes: charge(12, 'é😀') + charge(-7, ''), rows: 2 })
    await database(table).insert({ id: 12, payload: 'replacement 名字' }).onConflict('id').merge()
    expect(await counter()).toEqual({ bytes: charge(12, 'replacement 名字') + charge(-7, ''), rows: 2 })
    await expect(database(table).insert({ id: 12, payload: 'duplicate' })).rejects.toThrow()
    expect(await counter()).toEqual({ bytes: charge(12, 'replacement 名字') + charge(-7, ''), rows: 2 })
    await database(table).where('id', 12).update({ payload: '' })
    expect(await counter()).toEqual({ bytes: charge(12, '') + charge(-7, ''), rows: 2 })
    await database(table).where('id', -7).delete()
    expect(await counter()).toEqual({ bytes: charge(12, ''), rows: 1 })
    await database(table).where('id', 12).delete()
    expect(await counter()).toEqual({ bytes: 0, rows: 0 })
  })
})

test('SQLite quota exhaustion and inconsistent counter underflow preserve actual rows and counters atomically', async () => {
  await fixture(async database => {
    const initial = SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT - charge(1, 'original') + 1
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: initial })
    await expect(database(table).insert({ id: 1, payload: 'original' })).rejects.toThrow(
      'Shared journal quota exhausted or inconsistent'
    )
    expect(await database(table)).toEqual([])
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')).toEqual({
      bytes: initial,
      rows: 0
    })
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: 0 })
    await database(table).insert({ id: 1, payload: 'original' })
    await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).update({ bytes: 0 })
    await expect(database(table).where('id', 1).delete()).rejects.toThrow(
      'Shared journal quota exhausted or inconsistent'
    )
    expect(await database(table)).toEqual([{ id: 1, payload: 'original' }])
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).where('id', 0).first('bytes', 'rows')).toEqual({
      bytes: 0,
      rows: 1
    })
  })
})
