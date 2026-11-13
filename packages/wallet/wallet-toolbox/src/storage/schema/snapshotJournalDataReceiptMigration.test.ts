import { knex, type Knex } from 'knex'
import {
  addSnapshotSyncContentReceiptSchema,
  verifySnapshotSyncContentReceiptSchema,
  SNAPSHOT_SYNC_CONTENT_RECEIPTS
} from './snapshotSyncReceiptMigration'
import {
  addSnapshotJournalDataReceiptSchema,
  removeSnapshotJournalDataReceiptSchema,
  verifySnapshotJournalDataReceiptSchema,
  SNAPSHOT_JOURNAL_DATA_RECEIPTS,
  snapshotJournalDataReceiptDdl
} from './snapshotJournalDataReceiptMigration'

let k: Knex
beforeEach(async () => {
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await k.raw('PRAGMA foreign_keys=ON')
  await k.schema.createTable('users', t => {
    t.increments('userId')
    t.string('identityKey')
  })
  await k('users').insert({ userId: 1, identityKey: 'profile' })
  await k.schema.createTable('financial_marker', t => {
    t.integer('id').primary()
    t.binary('bytes')
  })
  await k('financial_marker').insert({ id: 1, bytes: Buffer.from([0, 255, 1]) })
})
afterEach(async () => await k.destroy())

test('journal DATA comparison migration is additive, repeatable and independently removable', async () => {
  await addSnapshotSyncContentReceiptSchema(k)
  const original = (await k('sqlite_master').where('name', SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).sql
  await addSnapshotJournalDataReceiptSchema(k)
  await addSnapshotJournalDataReceiptSchema(k)
  await verifySnapshotSyncContentReceiptSchema(k)
  await verifySnapshotJournalDataReceiptSchema(k)
  expect((await k('sqlite_master').where('name', SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).sql).toBe(original)
  expect((await k('financial_marker').first()).bytes).toEqual(Buffer.from([0, 255, 1]))
  await removeSnapshotJournalDataReceiptSchema(k)
  expect(await k.schema.hasTable(SNAPSHOT_JOURNAL_DATA_RECEIPTS)).toBe(false)
  expect(await k.schema.hasTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toBe(true)
  expect((await k('financial_marker').first()).bytes).toEqual(Buffer.from([0, 255, 1]))
  await addSnapshotJournalDataReceiptSchema(k)
  await verifySnapshotJournalDataReceiptSchema(k)
})

test.each(['column', 'trigger', 'shadow'] as const)('journal DATA schema refuses actual %s drift', async drift => {
  await addSnapshotJournalDataReceiptSchema(k)
  if (drift === 'column')
    await k.schema.alterTable(SNAPSHOT_JOURNAL_DATA_RECEIPTS, table => {
      table.integer('extra')
    })
  if (drift === 'trigger')
    await k.raw(
      'CREATE TRIGGER unexpected_data_receipt AFTER INSERT ON ' +
        SNAPSHOT_JOURNAL_DATA_RECEIPTS +
        ' BEGIN SELECT 1; END'
    )
  if (drift === 'shadow') await k.raw('CREATE TEMP TABLE ' + SNAPSHOT_JOURNAL_DATA_RECEIPTS + '(wrong INTEGER)')
  await expect(verifySnapshotJournalDataReceiptSchema(k)).rejects.toThrow('schema')
  await expect(addSnapshotJournalDataReceiptSchema(k)).rejects.toThrow('schema')
  expect((await k('financial_marker').first()).bytes).toEqual(Buffer.from([0, 255, 1]))
})

test('journal DATA DDL preserves the original completion fields with its own exact checkpoint column', async () => {
  await addSnapshotJournalDataReceiptSchema(k)
  const columns = await k.raw('PRAGMA table_info(' + SNAPSHOT_JOURNAL_DATA_RECEIPTS + ')')
  expect(columns.find((x: { name: string }) => x.name === 'checkpointJson')).toMatchObject({
    type: 'VARCHAR(4096)',
    notnull: 0
  })
  expect(columns.find((x: { name: string }) => x.name === 'activeStorage')).toMatchObject({ type: 'VARCHAR(256)' })
  const foreign = await k.raw('PRAGMA foreign_key_list(' + SNAPSHOT_JOURNAL_DATA_RECEIPTS + ')')
  expect(foreign).toHaveLength(1)
  expect(foreign[0]).toMatchObject({ table: 'users', from: 'userId', to: 'userId', on_delete: 'CASCADE' })
  const mysql = knex({ client: 'mysql2' })
  try {
    expect(snapshotJournalDataReceiptDdl(mysql)).toContain('ROW_FORMAT=DYNAMIC')
    expect(snapshotJournalDataReceiptDdl(mysql)).toContain('checkpointJson varchar(4096) NULL')
  } finally {
    await mysql.destroy()
  }
})
