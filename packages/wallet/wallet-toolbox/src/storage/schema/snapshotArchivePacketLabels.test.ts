import { knex, type Knex } from 'knex'
import { addSnapshotArchiveTables } from './snapshotArchiveMigration'
import {
  widenSnapshotArchivePacketLabels,
  supportsSnapshotArchivePacketLabels,
  refuseSnapshotArchivePacketLabelDowngrade
} from './snapshotArchivePacketLabels'
import { snapshotJournalFieldArchiveStorageTable } from '../snapshot/journal/SnapshotJournalArchiveStorageTable'

const metadata = {
  DATA_TYPE: 'varchar',
  CHARACTER_MAXIMUM_LENGTH: 32,
  IS_NULLABLE: 'NO',
  COLUMN_DEFAULT: null,
  CHARACTER_SET_NAME: 'utf8mb4',
  COLLATION_NAME: 'utf8mb4_bin',
  EXTRA: '',
  COLUMN_COMMENT: ''
}
function mysqlColumn(rows: unknown[]) {
  const state = { rows }
  const raw = jest.fn(async (sql: string, bindings: unknown[]) => {
    if (sql.startsWith('SELECT ')) {
      expect(bindings).toEqual(['snapshot_archive_pages', 'tableName'])
      return [state.rows]
    }
    expect(sql).toBe('ALTER TABLE ?? MODIFY COLUMN ?? VARCHAR(64) CHARACTER SET ?? COLLATE ?? NOT NULL')
    expect(bindings).toEqual(['snapshot_archive_pages', 'tableName', 'utf8mb4', 'utf8mb4_bin'])
    state.rows = [{ ...metadata, CHARACTER_MAXIMUM_LENGTH: 64 }]
    return []
  })
  return { db: { client: { config: { client: 'mysql2' } }, raw } as unknown as Knex, raw }
}

test('MySQL refuses old-width capability, widens exactly once and preserves its original charset/collation', async () => {
  const { db, raw } = mysqlColumn([{ ...metadata }])
  expect(await supportsSnapshotArchivePacketLabels(db)).toBe(false)
  await widenSnapshotArchivePacketLabels(db)
  await widenSnapshotArchivePacketLabels(db)
  expect(await supportsSnapshotArchivePacketLabels(db)).toBe(true)
  expect(raw.mock.calls.filter(([sql]) => sql.startsWith('ALTER '))).toHaveLength(1)
})

test.each([
  [],
  [metadata, metadata],
  [{ ...metadata, DATA_TYPE: 'text' }],
  [{ ...metadata, IS_NULLABLE: 'YES' }],
  [{ ...metadata, COLUMN_DEFAULT: '' }],
  [{ ...metadata, EXTRA: 'VIRTUAL GENERATED' }],
  [{ ...metadata, COLUMN_COMMENT: 'unowned' }],
  [{ ...metadata, CHARACTER_SET_NAME: null }],
  [{ ...metadata, COLLATION_NAME: null }],
  [{ ...metadata, COLLATION_NAME: 'utf8mb4_bin;DROP' }],
  [{ ...metadata, CHARACTER_SET_NAME: '' }],
  [{ ...metadata, CHARACTER_MAXIMUM_LENGTH: 16 }],
  [{ ...metadata, CHARACTER_MAXIMUM_LENGTH: 128 }]
])('unowned MySQL column shape %p never permits advertisement or ALTER', async (...rows) => {
  const { db, raw } = mysqlColumn(rows)
  expect(await supportsSnapshotArchivePacketLabels(db)).toBe(false)
  await expect(widenSnapshotArchivePacketLabels(db)).rejects.toThrow('differs from its owned schema')
  expect(raw.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(true)
})

test('SQLite retains its exact native DDL and long field packet data without a schema rewrite', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await addSnapshotArchiveTables(db)
    const schema = await db('sqlite_master').where({ name: 'snapshot_archive_pages' }).first('sql')
    const label = snapshotJournalFieldArchiveStorageTable('identities', { stream: 'scope', tableId: 12 })
    expect(label.length).toBeGreaterThan(32)
    await db('snapshot_archive_pages').insert({
      archiveId: 'a'.repeat(64),
      sequence: 0,
      tableName: label,
      rows: 0,
      done: true,
      digest: 'b'.repeat(64),
      payload: Buffer.from([0, 255])
    })
    await widenSnapshotArchivePacketLabels(db)
    await widenSnapshotArchivePacketLabels(db)
    expect(await supportsSnapshotArchivePacketLabels(db)).toBe(true)
    expect(await db('sqlite_master').where({ name: 'snapshot_archive_pages' }).first('sql')).toEqual(schema)
    await expect(refuseSnapshotArchivePacketLabelDowngrade()).rejects.toThrow('narrowing could truncate')
    expect(await db('snapshot_archive_pages').first()).toMatchObject({
      tableName: label,
      payload: Buffer.from([0, 255])
    })
  } finally {
    await db.destroy()
  }
})
