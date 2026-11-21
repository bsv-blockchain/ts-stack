import { previewDestinationFixture, previewReceiptPolicy } from '../../portable/Brc38ImportPreviewFixture'
import {
  migrateSnapshotJournalSqliteSourceAddition,
  readSnapshotJournalSqliteGeneration
} from './SnapshotJournalSqliteGeneration'
import { recordSnapshotJournalReceipt } from './SnapshotJournalReceipt'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { Knex } from 'knex'

const identityKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const addition = 'CREATE TRIGGER independent_baseline_addition BEFORE UPDATE ON users BEGIN SELECT 1; END'
async function withFixture(
  work: (fixture: Awaited<ReturnType<typeof previewDestinationFixture>>, userId: number) => Promise<void>
): Promise<void> {
  const fixture = await previewDestinationFixture()
  try {
    await fixture.k.raw('PRAGMA busy_timeout=0')
    const { user } = await fixture.storage.findOrInsertUser(identityKey)
    await fixture.storage.insertTxLabel({
      txLabelId: 0,
      userId: user.userId,
      label: 'independently retained journal event',
      isDeleted: false,
      created_at: new Date('2026-10-01T00:00:00Z'),
      updated_at: new Date('2026-10-01T00:00:00Z')
    })
    await work(fixture, user.userId)
  } finally {
    await fixture.close()
  }
}
async function journalData(k: Knex): Promise<Record<string, unknown[]>> {
  const tables = await k('main.sqlite_schema')
    .where({ type: 'table' })
    .whereRaw('substr(name,1,17)=?', ['snapshot_journal_'])
    .orderBy('name')
    .select('name')
  expect(tables.length).toBeGreaterThan(3)
  const result: Record<string, unknown[]> = {}
  for (const { name } of tables) if (name !== 'snapshot_journal_generation') result[name] = await k(name).select('*')
  return result
}
async function catalog(k: Knex): Promise<unknown[]> {
  return await k('main.sqlite_schema').select('type', 'name', 'tbl_name', 'rootpage', 'sql').orderBy(['type', 'name'])
}

test('source-owned addition rotates epoch/source and retains all actual journal rows and original wallet data', async () => {
  await withFixture(async ({ k }, userId) => {
    const before = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)
    await k('snapshot_journal_receipts').insert({
      requestId: 'e'.repeat(64),
      binding: '1'.repeat(64),
      highWater: String((await k('snapshot_journal_clock').first('revision')).revision),
      floor: '0',
      expiresAt: 1
    })
    const events = await journalData(k),
      wallet = await k('tx_labels').where({ userId }).select('*')
    expect((await k('snapshot_journal_clock').first('revision')).revision).toBeGreaterThan(0)
    await k.transaction(
      async writer =>
        await migrateSnapshotJournalSqliteSourceAddition(writer, async () => {
          await writer.raw(addition)
        })
    )
    const after = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)
    expect(after.epoch).not.toBe(before.epoch)
    expect(after.source).not.toBe(before.source)
    expect({ ...after, epoch: before.epoch, source: before.source }).toEqual(before)
    expect(await journalData(k)).toEqual(events)
    expect(await k('tx_labels').where({ userId }).select('*')).toEqual(wallet)
    expect((await k('main.sqlite_schema').where({ name: 'independent_baseline_addition' }).first('sql')).sql).toBe(
      addition
    )
  })
})

test('a genuine live capture receipt refuses source addition before its callback and retains all state', async () => {
  await withFixture(async ({ k }, userId) => {
    const before = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)
    const highWater = snapshotJournalRevision(String((await k('snapshot_journal_clock').first('revision')).revision))
    await k.transaction(
      async writer =>
        await recordSnapshotJournalReceipt(
          writer,
          {
            backend: '2'.repeat(64),
            schema: '3'.repeat(64),
            source: before.source,
            epoch: before.epoch,
            storageIdentity: 'independent source addition',
            identityKey,
            userId,
            chain: 'test'
          },
          { requestId: 'f'.repeat(64), highWater, expiresAt: Date.now() + 60000 }
        )
    )
    const events = await journalData(k),
      objects = await catalog(k)
    let called = false
    await expect(
      k.transaction(
        async writer =>
          await migrateSnapshotJournalSqliteSourceAddition(writer, async () => {
            called = true
            await writer.raw(addition)
          })
      )
    ).rejects.toThrow('Drain live journal captures')
    expect(called).toBe(false)
    expect(await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)).toEqual(before)
    expect(await journalData(k)).toEqual(events)
    expect(await catalog(k)).toEqual(objects)
  })
})

test('failed source addition rolls back its real DDL and retains the original epoch and all journal rows', async () => {
  await withFixture(async ({ k }) => {
    const before = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy),
      events = await journalData(k),
      objects = await catalog(k)
    const failure = new Error('independent source addition rollback')
    await expect(
      k.transaction(
        async writer =>
          await migrateSnapshotJournalSqliteSourceAddition(writer, async () => {
            await writer.raw(addition)
            throw failure
          })
      )
    ).rejects.toBe(failure)
    expect(await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)).toEqual(before)
    expect(await journalData(k)).toEqual(events)
    expect(await catalog(k)).toEqual(objects)
  })
})

test('source addition cannot bless an already-changed original source', async () => {
  await withFixture(async ({ k }) => {
    const before = await k('snapshot_journal_generation').first(),
      events = await journalData(k)
    let called = false
    await expect(
      k.transaction(async writer => {
        await writer.raw(addition)
        await migrateSnapshotJournalSqliteSourceAddition(writer, async () => {
          called = true
        })
      })
    ).rejects.toThrow('Invalid or unowned SQLite snapshot journal generation')
    expect(called).toBe(false)
    expect(await k('snapshot_journal_generation').first()).toEqual(before)
    expect(await journalData(k)).toEqual(events)
    expect(await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)).toMatchObject({
      epoch: before.epoch,
      source: before.source
    })
  })
})

test('source addition refuses a changed journal plan and atomically restores its original physical catalogue', async () => {
  await withFixture(async ({ k }) => {
    const before = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy),
      events = await journalData(k),
      objects = await catalog(k)
    await expect(
      k.transaction(
        async writer =>
          await migrateSnapshotJournalSqliteSourceAddition(writer, async () => {
            await writer.raw('DROP TRIGGER snapshot_journal_physical_0_UPDATE')
          })
      )
    ).rejects.toThrow('Invalid or unowned SQLite snapshot journal generation')
    expect(await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)).toEqual(before)
    expect(await journalData(k)).toEqual(events)
    expect(await catalog(k)).toEqual(objects)
  })
})
