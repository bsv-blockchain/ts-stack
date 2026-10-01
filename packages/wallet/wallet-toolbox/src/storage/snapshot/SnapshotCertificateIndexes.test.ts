import type { Knex } from 'knex'
import fc from 'fast-check'
import { runInSeries } from '../../utility/runInSeries'
import {
  minimalCertificateDatabase,
  expectCertificateMembership,
  seedCertificateFields,
  applyCertificateOperation,
  certificateFieldNames
} from '../../../test/utils/snapshotCertificateFixtures'
import {
  addSnapshotCertificateIndexes as install,
  removeSnapshotCertificateIndexes as remove,
  readSnapshotCertificateIndexState as enabled,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION as migration
} from '../schema/snapshotCertificateIndexMigration'

const databases: Knex[] = []
async function fixture(collation = 'BINARY'): Promise<Knex> {
  const k = await minimalCertificateDatabase(collation)
  databases.push(k)
  return k
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(databases.splice(0), k => k.destroy())
})

async function journal(k: Knex, table = 'knex_migrations'): Promise<void> {
  await k.schema.createTable(table, t => {
    t.string('name')
  })
  await k(table).insert({ name: migration })
}

test.each([0, 1, 255, 256, 257])(
  'bootstrap preserves the empty-name key for %s rows, source schema and repeat install/down',
  async count => {
    const k = await fixture()
    if (count) {
      await k('certificates').insert(
        Array.from({ length: count }, (_, i) => ({ certificateId: i + 1, userId: (i % 2) + 1 }))
      )
      await k('certificate_fields').insert(
        Array.from({ length: count }, (_, i) => ({
          certificateId: i + 1,
          userId: 1,
          fieldName: '',
          fieldValue: 'value'
        }))
      )
    }
    const schema = () =>
      k('sqlite_master').whereIn('type', ['table', 'index']).select('name', 'type', 'sql').orderBy('name')
    const before = await schema()
    await install(k)
    await install(k)
    await expectCertificateMembership(k)
    expect(await k('snapshot_certificate_index_progress').first()).toEqual({
      snapshotTableId: 0,
      started: count ? 1 : 0,
      afterFieldName: '',
      afterCertificateId: count,
      complete: 1
    })
    await remove(k)
    await remove(k)
    expect(await schema()).toEqual(before)
    expect(await k('certificate_fields')).toHaveLength(count)
    expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
  }
)

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'generated ownership, rekey and rollback schedules preserve source collation %s',
  async collation => {
    const k = await fixture(collation)
    await seedCertificateFields(k)
    await install(k)
    await expectCertificateMembership(k)
    const operation = fc.record({
      kind: fc.integer({ min: 0, max: 8 }),
      id: fc.integer({ min: 1, max: 4 }),
      user: fc.integer({ min: 1, max: 3 }),
      name: fc.integer({ min: 0, max: certificateFieldNames.length - 1 })
    })
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 24 }), async schedule => {
        await seedCertificateFields(k)
        await runInSeries(schedule, async op => {
          await applyCertificateOperation(k, op)
          await expectCertificateMembership(k)
        })
      }),
      { numRuns: 300, seed: 3242026 }
    )
  }
)

test('journal, complete positions and exact tables gate adoption in a custom migration journal', async () => {
  const k = await fixture()
  expect(await enabled(k)).toBe(false)
  await install(k)
  expect(await enabled(k)).toBe(false)
  await journal(k, 'custom_journal')
  const config = { tableName: 'custom_journal', schemaName: 'main' }
  expect(await enabled(k, config)).toBe(true)
  await k('custom_journal').update({ name: 'unrelated migration' })
  expect(await enabled(k, config)).toBe(false)
  await k('custom_journal').update({ name: migration })
  await k('snapshot_certificate_index_progress').update({ complete: 0 })
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k('snapshot_certificate_index_progress').update({ complete: 1 })
  await k('snapshot_certificate_index_progress').insert({
    snapshotTableId: 1,
    started: 0,
    afterFieldName: '',
    afterCertificateId: 0,
    complete: 1
  })
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k.schema.dropTable('snapshot_certificate_index_progress')
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k.schema.dropTable('snapshot_certificate_field_keys')
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
})

test.each([
  { started: 2 },
  { complete: 2 },
  { afterCertificateId: -1 },
  { afterCertificateId: 1.5 },
  { afterCertificateId: Number.MAX_SAFE_INTEGER + 1 },
  { afterCertificateId: 'invalid' },
  { afterFieldName: 'x'.repeat(101) },
  { afterFieldName: 'x' },
  { afterCertificateId: 1 },
  { started: 1, afterCertificateId: 0 }
])('invalid progress %j refuses before source reads', async change => {
  const k = await fixture()
  await install(k)
  await k('snapshot_certificate_index_progress').update({ complete: 0, ...change })
  const query = jest.fn()
  k.on('query', query)
  await expect(install(k)).rejects.toThrow('bootstrap position')
  expect(query.mock.calls.some(([q]) => q.sql.startsWith('select `userId`, `fieldName`, `certificateId`'))).toBe(false)
})

test.each([
  ['userId', 0],
  ['userId', -1],
  ['userId', 1.5],
  ['userId', 'invalid'],
  ['certificateId', 0],
  ['certificateId', -1],
  ['certificateId', 1.5],
  ['fieldName', 'x'.repeat(101)]
])('invalid source %s=%s rolls back keys and cursor', async (field, value) => {
  const k = await fixture()
  await k('certificate_fields').insert({
    userId: 1,
    fieldName: 'a',
    certificateId: 1,
    fieldValue: 'v',
    [field as string]: value
  })
  await expect(install(k)).rejects.toThrow('source key')
  expect(await k('snapshot_certificate_field_keys')).toEqual([])
  expect(await k('snapshot_certificate_index_progress').first()).toMatchObject({
    started: 0,
    complete: 0,
    afterCertificateId: 0
  })
})

test('committed bootstrap resumes behind-cursor changes after an interrupted next batch', async () => {
  const k = await fixture()
  await k('certificates').insert({ certificateId: 1, userId: 1 })
  await k('certificate_fields').insert(
    Array.from({ length: 300 }, (_, i) => ({
      userId: 1,
      certificateId: 1,
      fieldName: String(i + 1).padStart(6, '0'),
      fieldValue: 'v'
    }))
  )
  const failure = new Error('synthetic certificate migration interruption')
  let reads = 0
  const interrupt = (q: { sql: string }): void => {
    if (q.sql.startsWith('select `userId`, `fieldName`, `certificateId`') && ++reads === 2) throw failure
  }
  k.on('query', interrupt)
  try {
    await expect(install(k)).rejects.toBe(failure)
  } finally {
    k.off('query', interrupt)
  }
  expect(await k('snapshot_certificate_index_progress').first()).toMatchObject({
    started: 1,
    afterFieldName: '000256',
    afterCertificateId: 1,
    complete: 0
  })
  expect(await k('snapshot_certificate_field_keys')).toHaveLength(256)
  await k('certificate_fields').insert({ userId: 2, certificateId: 1, fieldName: '', fieldValue: 'late' })
  await k('certificates').update({ userId: 3 })
  await k('certificate_fields').where('fieldName', '000001').delete()
  await install(k)
  await expectCertificateMembership(k)
})

test('changed triggers refuse install and removal before altering any source or trigger', async () => {
  const k = await fixture()
  await install(k)
  await k.raw('DROP TRIGGER snapshot_certificate_field_insert')
  await k.raw('CREATE TRIGGER snapshot_certificate_field_insert AFTER INSERT ON certificate_fields BEGIN SELECT 1; END')
  const before = await k('sqlite_master').where('type', 'trigger').orderBy('name')
  await expect(install(k)).rejects.toThrow('trigger definition mismatch')
  await expect(remove(k)).rejects.toThrow('trigger definition mismatch')
  expect(await k('sqlite_master').where('type', 'trigger').orderBy('name')).toEqual(before)
})

test.each([
  'CREATE UNIQUE INDEX foreign_certificate ON snapshot_certificate_field_keys(snapshotCertificateId)',
  'ALTER TABLE snapshot_certificate_field_keys ADD COLUMN unexpected INTEGER',
  'DROP INDEX snapshot_certificate_parent'
])('schema inspection detects incompatible definitions: %s', async sql => {
  const k = await fixture()
  await install(k)
  await journal(k)
  await k.raw(sql)
  await expect(enabled(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
  if (sql.startsWith('DROP')) {
    await install(k)
    expect(await enabled(k)).toBe(true)
  } else await expect(install(k)).rejects.toThrow('table definition mismatch')
})

test.each([
  'snapshotCertificateId DESC,snapshotUserId,snapshotFieldName',
  'snapshotCertificateId,snapshotUserId,snapshotFieldName COLLATE NOCASE'
])('incompatible maintenance index %s refuses adoption', async columns => {
  const k = await fixture()
  await install(k)
  await k.raw('DROP INDEX snapshot_certificate_parent')
  await k.raw('CREATE INDEX snapshot_certificate_parent ON snapshot_certificate_field_keys(' + columns + ')')
  await expect(install(k)).rejects.toThrow('table definition mismatch')
})

test('a separately collated unique index cannot redefine the source cursor order', async () => {
  const k = await fixture()
  await k.schema.dropTable('certificate_fields')
  await k.raw(
    'CREATE TABLE certificate_fields(userId INTEGER,fieldName VARCHAR(100),certificateId INTEGER,fieldValue TEXT)'
  )
  await k.raw('CREATE UNIQUE INDEX wrong_order ON certificate_fields(fieldName COLLATE NOCASE,certificateId)')
  await expect(install(k)).rejects.toThrow('field order')
  expect(await k.schema.hasTable('snapshot_certificate_field_keys')).toBe(false)
})

test.each([
  'fieldName',
  'certificateId,fieldName',
  'fieldName,certificateId,userId',
  'fieldName DESC,certificateId',
  'fieldName,certificateId DESC',
  'fieldName,certificateId COLLATE NOCASE'
])('an incompatible source unique key %s cannot define the snapshot order', async columns => {
  const k = await fixture()
  await k.schema.dropTable('certificate_fields')
  await k.raw(
    'CREATE TABLE certificate_fields(userId INTEGER,fieldName VARCHAR(100),certificateId INTEGER,fieldValue TEXT)'
  )
  await k.raw('CREATE UNIQUE INDEX unsupported_source ON certificate_fields(' + columns + ')')
  await expect(install(k)).rejects.toThrow('Unsupported snapshot certificate field order')
  expect(await k.schema.hasTable('snapshot_certificate_field_keys')).toBe(false)
})

test.each([
  'renamedMembership INTEGER NOT NULL',
  'snapshotMembership TEXT NOT NULL',
  'snapshotMembership INTEGER',
  'snapshotMembership INTEGER NOT NULL DEFAULT 0',
  'snapshotMembership INTEGER GENERATED ALWAYS AS (1) VIRTUAL NOT NULL'
])('an incompatible owned column %s cannot be resumed, adopted or removed', async membership => {
  const k = await fixture()
  await install(k)
  await journal(k)
  await k.schema.dropTable('snapshot_certificate_field_keys')
  await k.raw(
    'CREATE TABLE snapshot_certificate_field_keys(snapshotUserId INTEGER NOT NULL,snapshotFieldName VARCHAR(100) NOT NULL,snapshotCertificateId INTEGER NOT NULL,' +
      membership +
      ',PRIMARY KEY(snapshotUserId,snapshotFieldName,snapshotCertificateId))'
  )
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(enabled(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
  expect(await k.schema.hasTable('snapshot_certificate_field_keys')).toBe(true)
})

test('resume accepts the full-width field cursor and refuses an unrelated progress row', async () => {
  const k = await fixture()
  await k('certificate_fields').insert({ userId: 1, certificateId: 1, fieldName: '😀'.repeat(100), fieldValue: 'v' })
  await install(k)
  await journal(k)
  expect(await enabled(k)).toBe(true)
  await install(k)
  await expectCertificateMembership(k)
  await k('snapshot_certificate_index_progress').update({ snapshotTableId: 1 })
  await expect(enabled(k)).rejects.toThrow('migration is incomplete')
})

test('bootstrap retains orphan fields as directly owned without inventing parent membership', async () => {
  const k = await fixture()
  await k('certificate_fields').insert({ userId: 7, fieldName: 'orphan', certificateId: 99, fieldValue: 'synthetic' })
  await install(k)
  await expectCertificateMembership(k)
  expect(await k('snapshot_certificate_field_keys')).toEqual([
    { snapshotUserId: 7, snapshotFieldName: 'orphan', snapshotCertificateId: 99, snapshotMembership: 1 }
  ])
})

test.each([
  'fieldName',
  'certificateId,fieldName',
  'fieldName,certificateId DESC',
  'fieldName,certificateId COLLATE NOCASE'
])('incompatible source unique index %s refuses before installing objects', async columns => {
  const k = await fixture()
  await k.schema.dropTable('certificate_fields')
  await k.raw(
    'CREATE TABLE certificate_fields(userId INTEGER,fieldName VARCHAR(100),certificateId INTEGER,fieldValue TEXT)'
  )
  await k.raw('CREATE UNIQUE INDEX wrong_order ON certificate_fields(' + columns + ')')
  await k.raw('CREATE INDEX nonunique_order ON certificate_fields(fieldName,certificateId)')
  await k.raw('CREATE UNIQUE INDEX partial_order ON certificate_fields(fieldName,certificateId) WHERE userId=1')
  await expect(install(k)).rejects.toThrow('field order')
  expect(await k.schema.hasTable('snapshot_certificate_field_keys')).toBe(false)
})

test('missing auxiliary primary-index metadata refuses without publishing progress', async () => {
  const k = await fixture()
  const omit = (rows: unknown, query: { sql: string }): void => {
    if (query.sql.startsWith('PRAGMA index_list(') && query.sql.includes('snapshot_certificate_field_keys'))
      (rows as unknown[]).splice(0)
  }
  k.on('query-response', omit)
  try {
    await expect(install(k)).rejects.toThrow('table definition mismatch')
  } finally {
    k.off('query-response', omit)
  }
  expect(await k.schema.hasTable('snapshot_certificate_index_progress')).toBe(false)
})
