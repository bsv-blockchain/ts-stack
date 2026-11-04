import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'

let KnexBrc38StagingStore: typeof import('./KnexBrc38StagingStore').KnexBrc38StagingStore
let readBrc38SqlBinaryDescriptors: typeof import('./Brc38SqlBinaryStaging').readBrc38SqlBinaryDescriptors
let brc38SqliteDefinitionBatches: typeof import('./Brc38SqlFieldSchemaBatch').brc38SqliteDefinitionBatches
let readBrc38SqliteDefinitionBatch: typeof import('./Brc38SqlFieldSchemaBatch').readBrc38SqliteDefinitionBatch
let readBrc38ImportSchemaFamily: typeof import('./Brc38ImportJournalSchemaBody').readBrc38ImportSchemaFamily

beforeAll(async () => {
  const storeModule = await import('./KnexBrc38StagingStore')
  KnexBrc38StagingStore = storeModule.KnexBrc38StagingStore
  const binaryModule = await import('./Brc38SqlBinaryStaging')
  readBrc38SqlBinaryDescriptors = binaryModule.readBrc38SqlBinaryDescriptors
  const batchModule = await import('./Brc38SqlFieldSchemaBatch')
  brc38SqliteDefinitionBatches = batchModule.brc38SqliteDefinitionBatches
  readBrc38SqliteDefinitionBatch = batchModule.readBrc38SqliteDefinitionBatch
  const familyModule = await import('./Brc38ImportJournalSchemaBody')
  readBrc38ImportSchemaFamily = familyModule.readBrc38ImportSchemaFamily
})

let directory = '',
  store: import('./KnexBrc38StagingStore').KnexBrc38StagingStore | undefined
const data = new Uint8Array([1, 2, 3])
const sha256 = createHash('sha256').update(data).digest('hex')
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brc38-schema-batch-'))
  store = await KnexBrc38StagingStore.create(directory, {
    maximumRows: 100,
    maximumLogicalBytes: 1048576,
    maximumPhysicalBytes: 4194304,
    maximumRowBytes: 65536,
    maximumRowAllocationBytes: 65536,
    expiresAt: Date.now() + 60000
  })
  await store.beginBinaryField('transactions', 0, 'rawTx', 'base64', 3)
  await store.appendBinaryField('transactions', 0, 'rawTx', 0, data)
  await store.finishBinaryField('transactions', 0, {
    field: 'rawTx',
    encoding: 'base64',
    bytes: 3,
    sha256
  })
})
afterEach(async () => {
  await store?.discard(new Error('finite schema comparison fixture cleanup'))
  await rm(directory, { recursive: true, force: true })
  store = undefined
})
async function read() {
  return await store!.knex.transaction(async trx => await readBrc38SqlBinaryDescriptors(trx, 'transactions', 0))
}
test('real descriptor reads retain exact bytes with bounded fresh catalog dispatches and statement bytes', async () => {
  let schemaQueries = 0,
    maximumStatementBytes = 0
  const observe = (query: { sql: string; bindings?: readonly unknown[] }): void => {
    if (!query.sql.includes('sqlite_schema')) return
    schemaQueries++
    maximumStatementBytes = Math.max(
      maximumStatementBytes,
      Buffer.byteLength(query.sql) +
        (query.bindings ?? []).reduce<number>(
          (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 8),
          0
        )
    )
  }
  store!.knex.on('query', observe)
  try {
    expect(await read()).toEqual({
      rawTx: { field: 'rawTx', encoding: 'base64', bytes: 3, sha256 }
    })
  } finally {
    store!.knex.off('query', observe)
  }
  expect(maximumStatementBytes).toBeLessThanOrEqual(32768)
  expect(schemaQueries).toBeLessThanOrEqual(2)
})

test.each([
  [
    'missing prefix',
    'DROP TRIGGER private_binary_chunks_prefix_delete',
    'Private structured immutable prefix definitions differ'
  ],
  [
    'altered prefix',
    'DROP TRIGGER private_binary_chunks_prefix_delete',
    'Private structured immutable prefix definitions differ'
  ],
  [
    'extra index',
    'CREATE INDEX private_binary_unexpected ON private_binary_fields(position)',
    'Private binary staging content or coordinate differs'
  ],
  [
    'altered table',
    'ALTER TABLE private_binary_fields ADD COLUMN unexpected TEXT',
    'Private binary staging content or coordinate differs'
  ],
  [
    'partial seal',
    'CREATE TRIGGER brc38_source_seal_incomplete BEFORE INSERT ON private_binary_fields BEGIN SELECT 1; END',
    'Authenticated private source write protection differs'
  ]
])('a successful real read never caches admission across %s', async (variant, sql, message) => {
  expect((await read()).rawTx.sha256).toBe(sha256)
  await store!.knex.raw(sql)
  if (variant === 'altered prefix')
    await store!.knex.raw(
      'CREATE TRIGGER private_binary_chunks_prefix_delete BEFORE DELETE ON private_binary_chunks BEGIN SELECT 1; END'
    )
  await expect(read()).rejects.toThrow(message)
})

test('real SQLite family batches preserve complete exact SQL, NULL indexes, UTF8 bounds and fresh rollback', async () => {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  const expected = new Map<string, { type: string; sql: string | null }>()
  try {
    for (let index = 0; index < 53; index++) {
      const name = 'brc38_batch_' + index,
        padding = index < 33 ? '' : ' /*' + 'm'.repeat(1900) + '*/',
        sql = `CREATE TABLE ${name}(id INTEGER PRIMARY KEY,value TEXT${padding})`
      await db.raw(sql)
      expected.set(name, { type: 'table', sql })
    }
    const longSql = 'CREATE TABLE brc38_batch_long(id INTEGER PRIMARY KEY,value TEXT /*' + '雪'.repeat(11000) + '😀*/)',
      nullSql = 'CREATE TABLE brc38_batch_null(id TEXT PRIMARY KEY,value TEXT)'
    await db.raw(longSql)
    await db.raw(nullSql)
    expected.set('brc38_batch_long', { type: 'table', sql: longSql })
    expected.set('brc38_batch_null', { type: 'table', sql: nullSql })
    expected.set('sqlite_autoindex_brc38_batch_null_1', { type: 'index', sql: null })
    const tables = [...expected].filter(([, row]) => row.type === 'table').map(([name]) => name)
    const batches = [...brc38SqliteDefinitionBatches(expected, tables)]
    expect(batches.some(batch => batch.definitions.length === 32)).toBe(true)
    expect(
      batches.find(batch => batch.definitions.some(row => row.name === 'brc38_batch_long'))?.definitions
    ).toHaveLength(1)
    for (const batch of batches) {
      const bytes =
        (batch.tableNames ?? []).reduce((sum, name) => sum + Buffer.byteLength(name), 0) +
        batch.definitions.reduce(
          (sum, row) =>
            sum +
            Buffer.byteLength(row.name) +
            Buffer.byteLength(row.type) +
            (row.sql === null ? 0 : Buffer.byteLength(row.sql)),
          0
        )
      expect(batch.definitions.length).toBeGreaterThan(0)
      expect(batch.definitions.length).toBeLessThanOrEqual(32)
      expect(bytes <= 32768 || batch.definitions.length === 1).toBe(true)
    }
    await db.transaction(async trx => {
      for (const batch of batches) {
        const comparison = await readBrc38SqliteDefinitionBatch(trx, batch, 'main.sqlite_schema')
        expect(comparison).toEqual({
          matches: batch.definitions.length,
          names: batch.definitions.length
        })
      }
      const scoped = await readBrc38SqliteDefinitionBatch(trx, {
        ...batches[0],
        tableNames: ['independent_unowned_table']
      })
      expect(scoped).toEqual({ matches: 0, names: 0 })
      const error = 'Independent schema family differs'
      expect(await readBrc38ImportSchemaFamily(trx, expected, ['brc38_batch_0'], error)).toEqual(expected)
      for (const variant of ['changed', 'type', 'index'] as const) {
        await trx.raw('SAVEPOINT independent_complete_batch_family')
        try {
          if (variant === 'index') await trx.raw('CREATE INDEX independent_batch_extra ON brc38_batch_5(value)')
          else {
            await trx.raw('DROP TABLE brc38_batch_5')
            if (variant === 'type') await trx.raw('CREATE VIEW brc38_batch_5 AS SELECT 1 AS id')
            else await trx.raw('CREATE TABLE brc38_batch_5(id INTEGER PRIMARY KEY,value INTEGER)')
          }
          await expect(readBrc38ImportSchemaFamily(trx, expected, ['brc38_batch_0'], error)).rejects.toThrow(error)
        } finally {
          await trx.raw('ROLLBACK TO independent_complete_batch_family')
          await trx.raw('RELEASE independent_complete_batch_family')
        }
        expect(await readBrc38ImportSchemaFamily(trx, expected, ['brc38_batch_0'], error)).toEqual(expected)
      }
      const changedNull = new Map(expected)
      changedNull.set('sqlite_autoindex_brc38_batch_null_1', { type: 'index', sql: '' })
      await expect(readBrc38ImportSchemaFamily(trx, changedNull, ['brc38_batch_0'], error)).rejects.toThrow(error)
      expect(await readBrc38ImportSchemaFamily(trx, expected, ['brc38_batch_0'], error)).toEqual(expected)
      await expect(readBrc38SqliteDefinitionBatch(trx, { definitions: [] })).rejects.toThrow(
        'Bounded SQLite definition comparison DATA required'
      )
      await expect(
        readBrc38SqliteDefinitionBatch(trx, {
          definitions: [...batches[0].definitions, batches[0].definitions[0]]
        })
      ).rejects.toThrow('Bounded SQLite definition comparison DATA required')
      await expect(readBrc38SqliteDefinitionBatch(trx, batches[0], 'sqlite_master' as 'sqlite_schema')).rejects.toThrow(
        'Bounded SQLite definition comparison DATA required'
      )
    })
  } finally {
    await db.destroy()
  }
})

test('fresh definition comparisons distinguish all-NULL implicit indexes from empty SQL and wrong identities', async () => {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  try {
    for (const name of ['one', 'two', 'three']) await db.raw(`CREATE TABLE null_batch_${name}(id TEXT PRIMARY KEY)`)
    const definitions = ['one', 'two', 'three'].map(name => ({
      name: `sqlite_autoindex_null_batch_${name}_1`,
      type: 'index',
      sql: null
    }))
    await db.transaction(async trx => {
      expect(await readBrc38SqliteDefinitionBatch(trx, { definitions })).toEqual({
        matches: 3,
        names: 3
      })
      for (const replacement of [
        { ...definitions[1], sql: '' },
        { ...definitions[1], name: 'missing_implicit_index' },
        { ...definitions[1], type: 'table' }
      ])
        expect(
          await readBrc38SqliteDefinitionBatch(trx, {
            definitions: [definitions[0], replacement, definitions[2]]
          })
        ).toEqual({ matches: 2, names: 2 })
      expect(await readBrc38SqliteDefinitionBatch(trx, { definitions })).toEqual({
        matches: 3,
        names: 3
      })
    })
  } finally {
    await db.destroy()
  }
})
