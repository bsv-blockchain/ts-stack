import { knex, type Knex } from 'knex'
import {
  nativeQuotaDispatchDdl,
  nativeQuotaDispatchTriggers,
  nativeQuotaSources
} from './SnapshotJournalNativeQuotaSql'
import {
  SNAPSHOT_JOURNAL_SHARED_QUOTA,
  SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
  SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
  snapshotJournalSharedQuotaDdl
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
    // Actual ordinary SQLite functions are an independent arithmetic oracle.
    // This checks SQL event/rollback semantics, not the genuine C guard/kernel.
    const connection = await database.client.acquireConnection()
    try {
      connection.function(
        'brc38_shared_row_charge',
        { varargs: true },
        (...values: unknown[]) =>
          4096 +
          4 *
            values.reduce<number>(
              (bytes, value) =>
                bytes +
                (value === null ? 0 : Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value), 'utf8')),
              0
            )
      )
      connection.function('brc38_shared_quota_next_bytes', { varargs: true }, (...values: number[]) => {
        const [bytes, rows, bit, byteLimit, rowLimit, before, after, delta] = values
        const next = bytes - before + after
        if (
          values.length !== 8 ||
          values.some(value => !Number.isSafeInteger(value)) ||
          byteLimit !== SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT ||
          rowLimit !== SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT ||
          ![0, 1].includes(bit) ||
          ![-1, 0, 1].includes(delta) ||
          before < 0 ||
          after < 0 ||
          bytes < before ||
          rows < (delta < 0 ? 1 : 0) ||
          next > byteLimit ||
          rows + delta > rowLimit
        )
          throw new Error('Shared journal quota exhausted or inconsistent')
        return next
      })
    } finally {
      await database.client.releaseConnection(connection)
    }
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
    for (const sql of nativeQuotaDispatchDdl) await database.raw(sql)
    for (const trigger of nativeQuotaDispatchTriggers([ddl])) await database.raw(trigger.sql)
    await work(database)
  } finally {
    await database.destroy()
  }
}

test('native dispatch SQL semantic feedback: quota triggers retain independent UTF8 charges across inserts, conflict updates and deletion', async () => {
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

test('quota parents retain every physical rowid required by the complete local inventory', async () => {
  await fixture(async database => {
    const factories = [
      require('./SnapshotJournalDestinationWindow').snapshotJournalDestinationWindowDdl,
      require('./SnapshotJournalDestinationStage').snapshotJournalDestinationStageDdl,
      require('./SnapshotJournalDestinationPromotion').snapshotJournalDestinationPromotionDdl,
      require('./SnapshotJournalCapturedIdentities').snapshotJournalCapturedIdentitiesDdl,
      require('./SnapshotJournalIdentityLedger').snapshotJournalIdentityLedgerDdl,
      require('./SnapshotJournalIdentityRetirements').snapshotJournalIdentityRetirementsDdl,
      require('./SnapshotJournalMemberships').snapshotJournalMembershipDdl,
      require('./SnapshotJournalProvenance').snapshotJournalProvenanceDdl,
      require('./SnapshotJournalProgress').snapshotJournalProgressDdl
    ] as Array<(database: Knex) => string[]>
    const sources = nativeQuotaSources(factories.flatMap(factory => factory(database)))
    expect(sources).toHaveLength(18)
    const inventory = require('../../portable/Brc38NativeLocalBaselineTables')
      .brc38NativeLocalBaselineTables as readonly string[]
    for (const source of sources) {
      expect(inventory).toContain(source.table)
      await database.raw(source.sql)
      expect(await database(source.table).select(database.raw('rowid')).limit(1)).toEqual([])
      expect(
        (await database.raw('PRAGMA table_list(??)', [source.table])).find(
          (row: { name: string }) => row.name === source.table
        ).wr
      ).toBe(0)
      expect(() => nativeQuotaSources([source.sql + ' WITHOUT ROWID'])).toThrow(
        'Unsupported native quota source definition'
      )
    }
    await database(table).insert({ id: 12, payload: 'é😀' })
    await database(table).insert({ id: 12, payload: '名字' }).onConflict('id').merge()
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).first('bytes', 'rows')).toEqual({
      bytes: charge(12, '名字'),
      rows: 1
    })
    expect(await database(table).select(database.raw('rowid'))).toHaveLength(1)
    await database(table).where('id', 12).delete()
    expect(await database(SNAPSHOT_JOURNAL_SHARED_QUOTA).first('bytes', 'rows')).toEqual({ bytes: 0, rows: 0 })
  })
})

test('native dispatch SQL semantic feedback: quota exhaustion and inconsistent counter underflow preserve actual rows and counters atomically', async () => {
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
