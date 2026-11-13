import { knex, type Knex } from 'knex'
import { addSnapshotSyncTables } from './snapshotSyncMigration'
import {
  addSnapshotSyncContentReceiptSchema,
  removeSnapshotSyncContentReceiptSchema,
  verifySnapshotSyncContentReceiptSchema,
  SNAPSHOT_SYNC_CONTENT_RECEIPTS
} from './snapshotSyncReceiptMigration'

let k: Knex
beforeEach(async () => {
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await k.raw('PRAGMA foreign_keys=ON')
  await k.schema.createTable('users', table => {
    table.increments('userId')
    table.string('activeStorage')
  })
  await k('users').insert([
    { userId: 1, activeStorage: 'source' },
    { userId: 2, activeStorage: 'other' }
  ])
})
afterEach(async () => await k.destroy())

const pending = (userId: number, sourceKey = '11'.repeat(32)) => ({
  userId,
  sourceKey,
  sourceStorageIdentityKey: 'source',
  version: 1,
  sessionId: '22'.repeat(32),
  snapshotId: '33'.repeat(32),
  sourceBinding: '44'.repeat(32),
  sourceContent: '55'.repeat(32),
  sourceMetadata: '66'.repeat(32),
  sourceHighWater: '100',
  sourceFloor: '0',
  destinationBinding: null,
  destinationContent: null,
  destinationMetadata: null,
  destinationHighWater: null,
  destinationFloor: null,
  primaryEpoch: null,
  activeStorage: null,
  complete: 0
})

test('additive receipt schema retries idempotently, preserves v1 data and scopes cleanup to its profile', async () => {
  await addSnapshotSyncTables(k)
  const original = await k('sqlite_master')
    .where('name', 'like', 'snapshot_sync_%')
    .select('name', 'sql')
    .orderBy('name')
  await k.transaction(async trx => await addSnapshotSyncContentReceiptSchema(trx))
  await addSnapshotSyncContentReceiptSchema(k)
  await verifySnapshotSyncContentReceiptSchema(k)
  expect(
    await k('sqlite_master')
      .where('name', 'like', 'snapshot_sync_%')
      .whereNot('tbl_name', SNAPSHOT_SYNC_CONTENT_RECEIPTS)
      .select('name', 'sql')
      .orderBy('name')
  ).toEqual(original)
  await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert([pending(1), pending(2)])
  await expect(k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert(pending(999))).rejects.toThrow('FOREIGN KEY')
  await expect(k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert(pending(1))).rejects.toThrow('UNIQUE')
  await expect(
    k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert({ ...pending(1, '66'.repeat(32)), complete: 2 })
  ).rejects.toThrow('CHECK')
  await k('users').where('userId', 1).delete()
  expect(await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).select('userId')).toEqual([{ userId: 2 }])
  await removeSnapshotSyncContentReceiptSchema(k)
  await removeSnapshotSyncContentReceiptSchema(k)
  expect(await k('users')).toEqual([{ userId: 2, activeStorage: 'other' }])
  expect(await k.schema.hasTable('snapshot_sync_sessions')).toBe(true)
  expect(await k.schema.hasTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toBe(false)
})

test('foreign/changed objects and temporary shadows refuse fresh receipt schema validation', async () => {
  await addSnapshotSyncContentReceiptSchema(k)
  await k.raw(`CREATE INDEX receipt_extra ON ${SNAPSHOT_SYNC_CONTENT_RECEIPTS}(sessionId)`)
  await expect(verifySnapshotSyncContentReceiptSchema(k)).rejects.toThrow('incomplete or changed')
  await k.raw('DROP INDEX receipt_extra')
  await verifySnapshotSyncContentReceiptSchema(k)
  await k.raw(`CREATE TRIGGER receipt_extra AFTER INSERT ON ${SNAPSHOT_SYNC_CONTENT_RECEIPTS} BEGIN SELECT 1; END`)
  await expect(addSnapshotSyncContentReceiptSchema(k)).rejects.toThrow('incomplete or changed')
  await k.raw('DROP TRIGGER receipt_extra')
  await k.raw(`CREATE TEMP TABLE ${SNAPSHOT_SYNC_CONTENT_RECEIPTS}(copied INTEGER)`)
  await expect(verifySnapshotSyncContentReceiptSchema(k)).rejects.toThrow('incomplete or changed')
  await k.raw(`DROP TABLE temp.${SNAPSHOT_SYNC_CONTENT_RECEIPTS}`)
  await verifySnapshotSyncContentReceiptSchema(k)
})

test('a same-name incompatible table is preserved rather than adopted or reset', async () => {
  await k.raw(`CREATE TABLE ${SNAPSHOT_SYNC_CONTENT_RECEIPTS}(userId INTEGER,payload TEXT)`)
  await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert({ userId: 1, payload: 'preserve existing data' })
  await expect(addSnapshotSyncContentReceiptSchema(k)).rejects.toThrow('incomplete or changed')
  await expect(removeSnapshotSyncContentReceiptSchema(k)).rejects.toThrow('incomplete or changed')
  expect(await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toEqual([{ userId: 1, payload: 'preserve existing data' }])
})
