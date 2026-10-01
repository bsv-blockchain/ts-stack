import type { Knex } from 'knex'
import fc from 'fast-check'
import { runInSeries } from '../../utility/runInSeries'
import {
  minimalGlobalDatabase,
  expectGlobalMembership,
  clearGlobalSource,
  applyGlobalOperation
} from '../../../test/utils/snapshotGlobalFixtures'
import {
  addSnapshotGlobalIndexes as install,
  removeSnapshotGlobalIndexes as remove,
  readSnapshotGlobalIndexState as enabled,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION as migration
} from '../schema/snapshotGlobalIndexMigration'

const databases: Knex[] = []
async function fixture(collation = 'BINARY') {
  const k = await minimalGlobalDatabase(collation)
  databases.push(k)
  return k
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(databases.splice(0), k => k.destroy())
})
async function journal(k: Knex, table = 'knex_migrations') {
  await k.schema.createTable(table, t => {
    void t.string('name')
  })
  await k(table).insert({ name: migration })
}

test.each([0, 1, 255, 256, 257, 600])(
  'bootstrap/replay preserve %s source rows without double counting',
  async count => {
    const k = await fixture()
    await k('proven_txs').insert([{ provenTxId: 7 }, { provenTxId: 9 }])
    await k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: 9 })
    await runInSeries(
      Array.from({ length: Math.ceil(count / 200) }, (_, i) => i * 200),
      async start => {
        await k('transactions').insert(
          Array.from({ length: Math.min(200, count - start) }, (_, i) => ({
            transactionId: start + i + 1,
            userId: (i % 2) + 1,
            txid: i % 2 ? 'a' : null,
            provenTxId: i % 2 ? 7 : null
          }))
        )
      }
    )
    const schema = () =>
      k('sqlite_master').whereIn('type', ['table', 'index']).select('name', 'type', 'sql').orderBy('name')
    const before = await schema()
    expect(await enabled(k)).toBe(false)
    await install(k)
    await expectGlobalMembership(k)
    const keys = await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId'])
    await install(k)
    expect(await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId'])).toEqual(keys)
    await k('snapshot_global_index_progress').where('id', 0).update({ afterRowId: 0, complete: false })
    await install(k)
    await expectGlobalMembership(k)
    expect(await k('snapshot_global_keys').orderBy(['tableId', 'userId', 'rowId'])).toEqual(keys)
    expect(await k('snapshot_global_index_progress').first()).toEqual({ id: 0, afterRowId: count, complete: 1 })
    await remove(k)
    await remove(k)
    expect(await schema()).toEqual(before)
    expect(await k('transactions')).toHaveLength(count)
    expect(await k('sqlite_master').where('type', 'trigger')).toEqual([])
  }
)

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'generated reference counts and presence match the independent union under %s',
  async collation => {
    const k = await fixture(collation)
    await install(k)
    const operation = fc.record({
      kind: fc.integer({ min: 0, max: 8 }),
      id: fc.integer({ min: 1, max: 5 }),
      userId: fc.integer({ min: 1, max: 3 }),
      otherId: fc.integer({ min: 1, max: 5 }),
      nullable: fc.boolean()
    })
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 24 }), async schedule => {
        await clearGlobalSource(k)
        await expectGlobalMembership(k)
        await runInSeries(schedule, async op => {
          await applyGlobalOperation(k, op)
          await expectGlobalMembership(k)
        })
      }),
      { numRuns: 300, seed: 3242026 }
    )
  }
)

test('shared proofs remain owned until their final basis disappears and rolled-back changes leave no edges', async () => {
  const k = await fixture()
  await install(k)
  await k('transactions').insert([
    { transactionId: 1, userId: 1, provenTxId: 7, txid: 'a' },
    { transactionId: 2, userId: 1, provenTxId: 7, txid: 'a' },
    { transactionId: 3, userId: 2, provenTxId: 7, txid: 'a' }
  ])
  await k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: 7 })
  await expectGlobalMembership(k)
  expect((await k('snapshot_global_keys').where({ tableId: 1, userId: 1, rowId: 7 }).first()).refs).toBe(4)
  expect((await k('snapshot_global_keys').where({ tableId: 1, userId: 1, rowId: 7 }).first()).present).toBe(0)
  await k('proven_txs').insert({ provenTxId: 7 })
  await expectGlobalMembership(k)
  await expect(
    k.transaction(async trx => {
      await trx('transactions').delete()
      throw new Error('synthetic rollback')
    })
  ).rejects.toThrow('synthetic rollback')
  await expectGlobalMembership(k)
  await k('transactions').where('transactionId', 1).delete()
  await expectGlobalMembership(k)
  expect((await k('snapshot_global_keys').where({ tableId: 1, userId: 1, rowId: 7 }).first()).refs).toBe(2)
  await k('transactions').where('transactionId', 2).delete()
  await expectGlobalMembership(k)
  expect(await k('snapshot_global_keys').where({ tableId: 1, userId: 1 })).toEqual([])
  await k('proven_txs').where('provenTxId', 7).delete()
  await expectGlobalMembership(k)
  await k('proven_txs').insert({ provenTxId: 7 })
  await expectGlobalMembership(k)
  await k('transactions').delete()
  await expectGlobalMembership(k)
  expect(await k('snapshot_global_keys')).toEqual([])
  expect(await k('snapshot_global_guards')).toEqual([])
})

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'full-width IDs and collation-equivalent text changes preserve references under %s',
  async collation => {
    const k = await fixture(collation)
    await install(k)
    await k('proven_txs').insert({ provenTxId: 4294967295 })
    await k('proven_tx_reqs').insert({ provenTxReqId: 4294967294, txid: 'A', provenTxId: 4294967295 })
    await k('transactions').insert({ transactionId: 4294967293, userId: 4294967292, txid: 'A', provenTxId: 4294967295 })
    await expectGlobalMembership(k)
    await runInSeries(['a', 'a ', 'é', 'e\u0301', 'A\0B', '😀'.repeat(64)], async txid => {
      await k('proven_tx_reqs').where('provenTxReqId', 4294967294).update({ txid })
      await expectGlobalMembership(k)
      await k('transactions').where('transactionId', 4294967293).update({ txid })
      await expectGlobalMembership(k)
    })
    await k('snapshot_global_index_progress').where('id', 0).update({ afterRowId: 0, complete: false })
    await install(k)
    await expectGlobalMembership(k)
  }
)

test.each([0, -1])(
  'bootstrap refuses an initial unsupported transaction ID %s and can resume after repair',
  async id => {
    const k = await fixture()
    await k('transactions').insert({ transactionId: id, userId: 1, txid: null, provenTxId: null })
    await expect(install(k)).rejects.toThrow('Invalid snapshot global source key')
    expect((await k('snapshot_global_index_progress').first()).complete).toBe(0)
    await k('transactions').where('transactionId', id).delete()
    await install(k)
    await expectGlobalMembership(k)
  }
)

test.each(['userId', 'provenTxId'])('bootstrap rejects unsupported %s without publishing progress', async field => {
  const k = await fixture()
  await k('transactions').insert({ transactionId: 1, userId: 1, txid: null, provenTxId: null, [field]: 0 })
  await expect(install(k)).rejects.toThrow('Invalid snapshot global source key')
  expect((await k('snapshot_global_index_progress').first()).afterRowId).toBe(0)
})

test('oversized SQLite transaction text is rejected before loading it as a lookup key', async () => {
  const k = await fixture()
  await k('transactions').insert({ transactionId: 1, userId: 1, txid: 'a'.repeat(257), provenTxId: null })
  await expect(install(k)).rejects.toThrow('Invalid snapshot global transaction key')
  expect(await k('snapshot_global_edges')).toEqual([])
  expect((await k('snapshot_global_index_progress').first()).afterRowId).toBe(0)
})

test.each(['knex_migrations', 'custom_migrations'])(
  'adoption requires exact owned tables and completed journal %s',
  async tableName => {
    const k = await fixture()
    await install(k)
    expect(await enabled(k, { tableName })).toBe(false)
    await journal(k, tableName)
    expect(await enabled(k, { tableName })).toBe(true)
    await k('snapshot_global_index_progress').where('id', 0).update({ complete: false })
    await expect(enabled(k, { tableName })).rejects.toThrow('incomplete')
    await install(k)
    expect(await enabled(k, { tableName })).toBe(true)
    await remove(k)
    await expect(enabled(k, { tableName })).rejects.toThrow('incomplete')
  }
)

test('altered trigger definitions are refused by install and removal before source changes', async () => {
  const k = await fixture()
  await install(k)
  await k.raw('DROP TRIGGER snapshot_global_tx_insert')
  await k.raw('CREATE TRIGGER snapshot_global_tx_insert AFTER INSERT ON transactions BEGIN SELECT 1; END')
  await expect(install(k)).rejects.toThrow('trigger definition mismatch')
  await expect(remove(k)).rejects.toThrow('trigger definition mismatch')
  expect(await k.schema.hasTable('snapshot_global_keys')).toBe(true)
})

test.each([
  'snapshot_global_guards',
  'snapshot_global_keys',
  'snapshot_global_edges',
  'snapshot_global_index_progress'
])('an unexpected %s column is refused for resume, adoption and removal', async table => {
  const k = await fixture()
  await install(k)
  await journal(k)
  await k.schema.alterTable(table, t => {
    void t.integer('unexpected')
  })
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(enabled(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
  expect(await k.schema.hasTable('snapshot_global_keys')).toBe(true)
})

test.each([
  'transactionId INTEGER NOT NULL, userId INTEGER NOT NULL, provenTxId INTEGER, txid VARCHAR(64)',
  'transactionId INTEGER NOT NULL, userId INTEGER NOT NULL, provenTxId INTEGER, txid VARCHAR(64), PRIMARY KEY(transactionId,userId)',
  'otherId INTEGER NOT NULL PRIMARY KEY, transactionId INTEGER, userId INTEGER NOT NULL, provenTxId INTEGER, txid VARCHAR(64)'
])('unsupported SQLite source key refuses before auxiliary DDL: %s', async columns => {
  const k = await fixture()
  await k.schema.dropTable('transactions')
  await k.raw(`CREATE TABLE transactions(${columns})`)
  await expect(install(k)).rejects.toThrow('Unsupported snapshot global source key')
  expect(await k.schema.hasTable('snapshot_global_guards')).toBe(false)
})

test.each([
  'transactionId INTEGER PRIMARY KEY, userId TEXT NOT NULL, provenTxId INTEGER, txid VARCHAR(64)',
  'transactionId INTEGER PRIMARY KEY, userId INTEGER, provenTxId INTEGER, txid VARCHAR(64)',
  'transactionId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, txid VARCHAR(64)',
  'transactionId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, provenTxId INTEGER, txid TEXT',
  'transactionId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, provenTxId INTEGER, txid VARCHAR(64) NOT NULL',
  'transactionId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, provenTxId INTEGER GENERATED ALWAYS AS (userId) VIRTUAL, txid VARCHAR(64)'
])('unsupported SQLite source column refuses before auxiliary DDL: %s', async columns => {
  const k = await fixture()
  await k.schema.dropTable('transactions')
  await k.raw(`CREATE TABLE transactions(${columns})`)
  await expect(install(k)).rejects.toThrow('Unsupported snapshot global source column')
  expect(await k.schema.hasTable('snapshot_global_guards')).toBe(false)
})

test.each(['(userId)', '(txid DESC)', '(txid COLLATE NOCASE)', '(txid) WHERE userId = 1'])(
  'an incomplete or differently ordered source lookup is refused: %s',
  async definition => {
    const k = await fixture()
    await k.schema.dropTable('transactions')
    await k.raw(
      'CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,provenTxId INTEGER,txid VARCHAR(64))'
    )
    await k.raw(`CREATE INDEX synthetic_txid_lookup ON transactions${definition}`)
    await expect(install(k)).rejects.toThrow('requires complete transaction lookup indexes')
    expect(await k.schema.hasTable('snapshot_global_guards')).toBe(false)
  }
)

test('SQLite source txid comparison metadata must agree between transactions and requests', async () => {
  const k = await fixture()
  await k.schema.dropTable('transactions')
  await k.raw(
    'CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,provenTxId INTEGER,txid VARCHAR(64) COLLATE NOCASE)'
  )
  await k.raw('CREATE INDEX synthetic_txid_lookup ON transactions(txid)')
  await expect(install(k)).rejects.toThrow('require matching text definitions')
  expect(await k.schema.hasTable('snapshot_global_guards')).toBe(false)
})

test.each([
  '(tableId,userId,present,rowId DESC)',
  '(tableId,userId,present,rowId COLLATE NOCASE)',
  '(tableId,userId,present)',
  '(tableId,present,userId,rowId)',
  '(tableId,userId,present,rowId) WHERE refs > 0'
])('altered auxiliary page order refuses resume, adoption and down: %s', async definition => {
  const k = await fixture()
  await install(k)
  await journal(k)
  await k.raw('DROP INDEX snapshot_global_page')
  await k.raw(`CREATE INDEX snapshot_global_page ON snapshot_global_keys${definition}`)
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(enabled(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
  expect(await k.schema.hasTable('snapshot_global_keys')).toBe(true)
})

test.each([{ afterRowId: -1 }, { afterRowId: 1.5 }, { complete: 2 }, { id: 1 }])(
  'malformed bootstrap progress %j refuses resume and journal adoption',
  async changed => {
    const k = await fixture()
    await install(k)
    await journal(k)
    await k('snapshot_global_index_progress').where('id', 0).update(changed)
    await expect(enabled(k)).rejects.toThrow('incomplete')
    if (!('id' in changed)) await expect(install(k)).rejects.toThrow('Invalid snapshot global bootstrap position')
  }
)

test('qualified migration journals and empty progress refuse or adopt the same schema', async () => {
  const k = await fixture()
  expect(await enabled(k, { schemaName: 'main' })).toBe(false)
  await install(k)
  await journal(k)
  expect(await enabled(k, { schemaName: 'main' })).toBe(true)
  await k('snapshot_global_index_progress').delete()
  await expect(enabled(k, { schemaName: 'main' })).rejects.toThrow('incomplete')
})

test('bootstrap preserves missing request and missing proof distinctions', async () => {
  const k = await fixture()
  await k('proven_tx_reqs').insert({ provenTxReqId: 5, txid: 'a', provenTxId: null })
  await k('transactions').insert([
    { transactionId: 1, userId: 1, txid: 'missing', provenTxId: null },
    { transactionId: 2, userId: 1, txid: 'missing', provenTxId: 7 },
    { transactionId: 3, userId: 1, txid: 'a', provenTxId: null }
  ])
  await install(k)
  await expectGlobalMembership(k)
  expect(await k('snapshot_global_keys').orderBy('tableId')).toEqual([
    { tableId: 0, userId: 1, rowId: 5, refs: 1, present: 1 },
    { tableId: 1, userId: 1, rowId: 7, refs: 1, present: 0 }
  ])
})

test('unexpected unique auxiliary constraints refuse adoption before they can reject valid source writes', async () => {
  const k = await fixture()
  await install(k)
  await journal(k)
  await k.raw('CREATE UNIQUE INDEX synthetic_extra_unique ON snapshot_global_keys(rowId)')
  await expect(install(k)).rejects.toThrow('table definition mismatch')
  await expect(enabled(k)).rejects.toThrow('table definition mismatch')
  await expect(remove(k)).rejects.toThrow('table definition mismatch')
})

test('inconsistent SQLite primary-index metadata refuses adoption instead of assuming its key exists', async () => {
  const k = await fixture()
  await install(k)
  const raw = k.client.raw.bind(k.client)
  jest.spyOn(k.client, 'raw').mockImplementation((...args: Parameters<Knex['raw']>) => {
    const query = raw(...args)
    if (args[0] === 'PRAGMA index_list(??)' && Array.isArray(args[1]) && args[1][0] === 'snapshot_global_keys') {
      return query.then((rows: Array<{ origin: string }>) =>
        rows.filter(row => row.origin !== 'pk')
      ) as unknown as Knex.Raw
    }
    return query
  })
  await expect(install(k)).rejects.toThrow('table definition mismatch')
})
