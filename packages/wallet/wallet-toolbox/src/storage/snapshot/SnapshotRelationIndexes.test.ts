import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { expectRelationMembership, minimalRelationDatabase } from '../../../test/utils/snapshotRelationFixtures'
import {
  addSnapshotRelationIndexes as install,
  removeSnapshotRelationIndexes as remove,
  readSnapshotRelationIndexState as enabled,
  SNAPSHOT_RELATION_INDEX_MIGRATION as migration
} from '../schema/snapshotRelationIndexMigration'

const databases: Knex[] = []
async function fixture(): Promise<Knex> {
  const k = await minimalRelationDatabase()
  databases.push(k)
  return k
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(databases.splice(0), k => k.destroy())
})

test.each([0, 1, 255, 256, 257])(
  'bootstrap resumes the composite cursor for %p mappings without altering source indexes',
  async count => {
    const k = await fixture()
    await k('tx_labels').insert({ txLabelId: 1, userId: 1 })
    if (count) {
      await k('transactions').insert(
        Array.from({ length: count }, (_, i) => ({ transactionId: i + 1, userId: (i % 2) + 1 }))
      )
      await k('tx_labels_map').insert(
        Array.from({ length: count }, (_, i) => ({ txLabelId: 1, transactionId: i + 1, isDeleted: i % 2 }))
      )
    }
    const schema = () =>
      k('sqlite_master').whereIn('type', ['table', 'index']).select('name', 'type', 'sql').orderBy('name')
    const before = await schema()
    await install(k)
    await install(k)
    await expectRelationMembership(k)
    expect(await k('snapshot_relation_index_progress').where('snapshotTableId', 0).first()).toEqual({
      snapshotTableId: 0,
      afterLeftId: count ? 1 : 0,
      afterRightId: count,
      complete: 1
    })
    await remove(k)
    await remove(k)
    expect(await schema()).toEqual(before)
    expect(await k('tx_labels_map')).toHaveLength(count)
    expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
  }
)

test('a committed bootstrap page resumes after failure and preserves lower-key writes and owner changes', async () => {
  const k = await fixture()
  await k('tx_labels').insert({ txLabelId: 1, userId: 1 })
  await k('transactions').insert(Array.from({ length: 300 }, (_, i) => ({ transactionId: i + 2, userId: 1 })))
  await k('tx_labels_map').insert(
    Array.from({ length: 300 }, (_, i) => ({ txLabelId: 1, transactionId: i + 2, isDeleted: false }))
  )
  const failure = new Error('synthetic relation bootstrap interruption')
  let reads = 0
  const interrupt = (query: { sql: string }): void => {
    if (query.sql.startsWith('select `txLabelId`, `transactionId` from `tx_labels_map`') && ++reads === 2) throw failure
  }
  k.on('query', interrupt)
  try {
    await expect(install(k)).rejects.toBe(failure)
  } finally {
    k.off('query', interrupt)
  }
  expect(await k('snapshot_relation_index_progress').where('snapshotTableId', 0).first()).toEqual({
    snapshotTableId: 0,
    afterLeftId: 1,
    afterRightId: 257,
    complete: 0
  })
  expect(await k('snapshot_relation_keys')).toHaveLength(256)
  await k('transactions').insert({ transactionId: 1, userId: 2 })
  await k('tx_labels_map').insert({ txLabelId: 1, transactionId: 1, isDeleted: true })
  await k('tx_labels').where('txLabelId', 1).update({ userId: 3 })
  await k('tx_labels_map').where('transactionId', 2).delete()
  await install(k)
  await expectRelationMembership(k)
})

test('membership retains both ownership bases, cross-profile and orphan visibility, and physical deletion semantics', async () => {
  const k = await fixture()
  await install(k)
  await k('tx_labels').insert({ txLabelId: 1, userId: 1 })
  await k('transactions').insert({ transactionId: 1, userId: 1 })
  await k('tx_labels_map').insert({ txLabelId: 1, transactionId: 1, isDeleted: true })
  await expectRelationMembership(k)
  expect((await k('snapshot_relation_keys').first()).snapshotMembership).toBe(3)
  await k('tx_labels').where('txLabelId', 1).update({ userId: 2 })
  await expectRelationMembership(k)
  expect(await k('snapshot_relation_keys')).toHaveLength(2)
  await k('transactions').delete()
  await expectRelationMembership(k)
  expect((await k('snapshot_relation_keys').first()).snapshotMembership).toBe(1)
  await k('tx_labels_map').delete()
  await expectRelationMembership(k)
  expect(await k('snapshot_relation_keys')).toEqual([])
})

test('journal, complete positions and exact tables are required before selecting indexed reads', async () => {
  const k = await fixture()
  expect(await enabled(k)).toBe(false)
  await install(k)
  expect(await enabled(k)).toBe(false)
  await k.schema.createTable('custom_journal', t => {
    t.string('name')
  })
  const config = { tableName: 'custom_journal', schemaName: 'main' }
  await k('custom_journal').insert({ name: 'unrelated migration' })
  expect(await enabled(k, config)).toBe(false)
  await k('custom_journal').insert({ name: migration })
  expect(await enabled(k, config)).toBe(true)
  await k('snapshot_relation_index_progress').where('snapshotTableId', 1).update({ complete: 0 })
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k('snapshot_relation_index_progress').where('snapshotTableId', 1).update({ complete: 1, afterRightId: -1 })
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k('snapshot_relation_index_progress').where('snapshotTableId', 1).delete()
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k.schema.dropTable('snapshot_relation_index_progress')
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
  await k.schema.dropTable('snapshot_relation_keys')
  await expect(enabled(k, config)).rejects.toThrow('migration is incomplete')
})

test.each([
  { afterLeftId: -1 },
  { afterRightId: -1 },
  { afterLeftId: 1.5 },
  { afterRightId: 'invalid' },
  { afterLeftId: Number.MAX_SAFE_INTEGER + 1 },
  { complete: 2 }
])('invalid progress %j refuses before reading source maps', async change => {
  const k = await fixture()
  await install(k)
  await k('snapshot_relation_index_progress')
    .where('snapshotTableId', 0)
    .update({ complete: 0, ...change })
  const read = jest.fn()
  k.on('query', read)
  await expect(install(k)).rejects.toThrow('bootstrap position')
  expect(read.mock.calls.some(([q]) => q.sql.startsWith('select `txLabelId`, `transactionId` from'))).toBe(false)
})

test.each([0, -1, 1.5, 'invalid', Number.MAX_SAFE_INTEGER + 1])(
  'invalid parent owner %p rolls back its page and checkpoint',
  async userId => {
    const k = await fixture()
    await k('tx_labels').insert({ txLabelId: 1, userId })
    await k('tx_labels_map').insert({ txLabelId: 1, transactionId: 1, isDeleted: false })
    await expect(install(k)).rejects.toThrow('source key')
    expect(await k('snapshot_relation_keys')).toEqual([])
    expect(await k('snapshot_relation_index_progress').where('snapshotTableId', 0).first()).toEqual({
      snapshotTableId: 0,
      afterLeftId: 0,
      afterRightId: 0,
      complete: 0
    })
  }
)

test('conflicting trigger definitions refuse adoption and removal before dropping any observer or producer', async () => {
  const k = await fixture()
  await install(k)
  await k.raw('DROP TRIGGER snapshot_relation_1_right_delete')
  await k.raw('CREATE TRIGGER snapshot_relation_1_right_delete AFTER DELETE ON outputs BEGIN SELECT 1; END')
  const before = await k('sqlite_master').where('type', 'trigger').orderBy('name')
  await expect(install(k)).rejects.toThrow('trigger definition mismatch')
  await expect(remove(k)).rejects.toThrow('trigger definition mismatch')
  expect(await k('sqlite_master').where('type', 'trigger').orderBy('name')).toEqual(before)
  expect(await k.schema.hasTable('snapshot_relation_keys')).toBe(true)
})

test.each([
  'CREATE UNIQUE INDEX foreign_unique_relation ON snapshot_relation_keys(snapshotLeftId)',
  'DROP INDEX snapshot_relation_right',
  'CREATE INDEX foreign_partial_relation ON snapshot_relation_keys(snapshotRightId) WHERE snapshotMembership=1'
])('schema inspection preserves unrelated definitions: %s', async sql => {
  const k = await fixture()
  await install(k)
  await k.raw(sql)
  if (sql.startsWith('CREATE INDEX foreign_partial')) {
    await install(k)
    await expectRelationMembership(k)
  } else if (sql.startsWith('DROP')) {
    await expect(remove(k)).rejects.toThrow('table definition mismatch')
    await install(k)
    expect(await k('sqlite_master').where({ type: 'index', name: 'snapshot_relation_right' })).toHaveLength(1)
  } else {
    await expect(install(k)).rejects.toThrow('table definition mismatch')
    await expect(remove(k)).rejects.toThrow('table definition mismatch')
    expect(await k('sqlite_master').where({ type: 'index', name: 'foreign_unique_relation' })).toHaveLength(1)
  }
})

test('partial, reversed or wrong-column maintenance indexes cannot silently replace required indexes', async () => {
  const k = await fixture()
  await install(k)
  await k.raw('DROP INDEX snapshot_relation_right')
  await k.raw(
    'CREATE INDEX snapshot_relation_right ON snapshot_relation_keys(snapshotTableId,snapshotUserId,snapshotRightId DESC,snapshotLeftId)'
  )
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
})

test('a foreign auxiliary table shape refuses adoption and removal without changing its rows', async () => {
  const k = await fixture()
  await k.schema.createTable('snapshot_relation_keys', t => {
    t.text('unrelated')
  })
  await k('snapshot_relation_keys').insert({ unrelated: 'preserve' })
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
  expect(await k('snapshot_relation_keys')).toEqual([{ unrelated: 'preserve' }])
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
})

test('missing primary-index metadata refuses before installing triggers or publishing progress', async () => {
  const k = await fixture()
  const omit = (rows: unknown, query: { sql: string }): void => {
    if (query.sql.startsWith('PRAGMA index_list(') && query.sql.includes('snapshot_relation_keys')) {
      expect(Array.isArray(rows)).toBe(true)
      ;(rows as unknown[]).splice(0)
    }
  }
  k.on('query-response', omit)
  try {
    await expect(install(k)).rejects.toThrow('table definition mismatch')
  } finally {
    k.off('query-response', omit)
  }
  expect(await k.schema.hasTable('snapshot_relation_index_progress')).toBe(false)
  expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
})

test('bootstrap retains the existing owner of an inconsistent mapping and permits a missing ownership basis', async () => {
  const k = await fixture()
  await k('tx_labels').insert({ txLabelId: 1, userId: 1 })
  await k('tx_labels_map').insert([
    { txLabelId: 1, transactionId: 1, isDeleted: true },
    { txLabelId: 2, transactionId: 2, isDeleted: false }
  ])
  await install(k)
  await expectRelationMembership(k)
  expect(await k('snapshot_relation_keys')).toEqual([
    { snapshotTableId: 0, snapshotUserId: 1, snapshotLeftId: 1, snapshotRightId: 1, snapshotMembership: 1 }
  ])
  expect(await k('snapshot_relation_index_progress').where('complete', 1)).toHaveLength(2)
})
