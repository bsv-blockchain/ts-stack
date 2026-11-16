import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import fc from 'fast-check'

import { runInSeries } from '../../utility/runInSeries'
import type { Brc38KnexSourceOptions } from './Brc38KnexSource'

import type { BRC38WalletData } from './index'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

type StorageKnex = import('../StorageKnex').StorageKnex
let StorageKnex: typeof import('../StorageKnex').StorageKnex
let migrateBeforeSqliteGeneration: typeof import('../../../test/utils/snapshotHistoricalMigrations').migrateBeforeSqliteGeneration
let StorageProvider: typeof import('../StorageProvider').StorageProvider
let openBrc38KnexSource: typeof import('./Brc38KnexSource').openBrc38KnexSource
let createBrc38Stream: typeof import('./Brc38Stream').createBrc38Stream
let exportBRC38: typeof import('./index').exportBRC38
let parseBRC38Json: typeof import('./index').parseBRC38Json

// Load real integration entries in awaited setup. Initialization guards must
// fail within the tests rather than preventing their assertions from loading.
beforeAll(async () => {
  const fixtureModule0 = await import('../StorageKnex')
  StorageKnex = fixtureModule0.StorageKnex
  const fixtureModule1 = await import('../../../test/utils/snapshotHistoricalMigrations')
  migrateBeforeSqliteGeneration = fixtureModule1.migrateBeforeSqliteGeneration
  const fixtureModule2 = await import('../StorageProvider')
  StorageProvider = fixtureModule2.StorageProvider
  const fixtureModule3 = await import('./Brc38KnexSource')
  openBrc38KnexSource = fixtureModule3.openBrc38KnexSource
  const fixtureModule4 = await import('./Brc38Stream')
  createBrc38Stream = fixtureModule4.createBrc38Stream
  const fixtureModule5 = await import('./index')
  exportBRC38 = fixtureModule5.exportBRC38
  parseBRC38Json = fixtureModule5.parseBRC38Json
})

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

const identity = '02' + '11'.repeat(32)
const foreignIdentity = '03' + '22'.repeat(32)
const date = '2026-01-01T00:00:00.000Z'
const timestamp = { created_at: date, updated_at: date }
const stores: StorageKnex[] = [],
  directories: string[] = []
const options: Brc38KnexSourceOptions = {
  maximumPageRows: 1,
  maximumPageBytes: 65536,
  maximumRowAllocationBytes: 65536,
  maximumCertificateGroupBytes: 65536,
  lifetimeMs: 300000
}
test('strict structured source refuses a copied/stock native label before opening a view', async () => {
  const openReadSnapshot = jest.fn(),
    storage = {
      dbtype: 'SQLite',
      chain: 'test',
      openReadSnapshot,
      knex: { isTransaction: false, client: { config: { client: 'better-sqlite3' } } }
    } as unknown as StorageKnex
  await expect(
    openBrc38KnexSource(storage, identity, {
      ...options,
      streamedStructured: {
        maximumStructuredBytes: 1000000000,
        privateIndexParent: '/private/unused',
        maximumTemporaryIndexBytes: 1048576,
        maximumIndexMembers: 2000000000
      }
    })
  ).rejects.toThrow('genuinely owned')
  expect(openReadSnapshot).not.toHaveBeenCalled()
})
test.each([0, 1048575, 17179869185, NaN, Infinity])(
  'invalid native sort file budget %p refuses before source I/O',
  async budget => {
    const openReadSnapshot = jest.fn(),
      storage = { openReadSnapshot } as unknown as StorageKnex
    await expect(
      openBrc38KnexSource(storage, identity, {
        ...options,
        streamedStructured: {
          maximumStructuredBytes: 1000000000,
          privateIndexParent: '/private/unused',
          maximumTemporaryIndexBytes: budget,
          maximumIndexMembers: 2000000000
        }
      })
    ).rejects.toThrow()
    expect(openReadSnapshot).not.toHaveBeenCalled()
  }
)
async function fixture(historicalIndexes = false) {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-coherent-'))
  directories.push(directory)
  const open = () => {
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(storage)
    return storage
  }
  const source = open()
  await source.knex.raw('PRAGMA journal_mode = WAL')
  if (historicalIndexes) await migrateBeforeSqliteGeneration(source, 'original source', 'source-storage')
  else await source.migrate('original source', 'source-storage')
  await source.makeAvailable()
  const { user } = await source.findOrInsertUser(identity),
    { user: other } = await source.findOrInsertUser(foreignIdentity)
  const writer = open()
  await writer.makeAvailable()
  return { source, writer, userId: user.userId, otherId: other.userId }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(stores.splice(0), storage => storage.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Uint8Array[] = []
  for await (const bytes of chunks) {
    expect(bytes.length).toBeLessThanOrEqual(64)
    result.push(bytes)
  }
  return Buffer.concat(result)
}
async function archive(source: StorageKnex, exportedAt: string, selected = options): Promise<BRC38WalletData> {
  const owner = await openBrc38KnexSource(source, identity, selected)
  const stream = await createBrc38Stream(owner, {
    exportedAt,
    maximumArchiveBytes: 1048576,
    maximumRowBytes: 65536,
    maximumChunkBytes: 64
  })
  try {
    const data = parseBRC38Json((await collect(stream.chunks)).toString())
    await stream.validateCompleted()
    return data
  } finally {
    await stream.close()
  }
}

async function seedProofs(k: StorageKnex['knex'], id: number, userId: number, otherId: number): Promise<void> {
  await k('proven_txs').insert({
    ...timestamp,
    provenTxId: id,
    txid: String(id).repeat(64),
    height: id,
    index: 0,
    merklePath: Buffer.from([id, 0, 255]),
    rawTx: Buffer.from([id, 1, 255]),
    blockHash: 'a'.repeat(64),
    merkleRoot: 'b'.repeat(64)
  })
  await k('transactions').insert({
    ...timestamp,
    transactionId: id,
    userId: id === 2 ? otherId : userId,
    provenTxId: id === 3 ? null : id,
    status: 'completed',
    reference: `tx-${id}`,
    isOutgoing: true,
    satoshis: 0,
    description: `tx-${id}`,
    txid: String(id).repeat(64),
    rawTx: Buffer.from([id, 2, 255]),
    inputBEEF: Buffer.from([id, 3, 255])
  })
  await k('proven_tx_reqs').insert({
    ...timestamp,
    provenTxReqId: id,
    provenTxId: id,
    txid: String(id).repeat(64),
    status: 'completed',
    attempts: 0,
    notified: true,
    history: '{}',
    notify: '{}',
    rawTx: Buffer.from([id, 4, 255]),
    wasBroadcast: true
  })
}
async function seedOutputs(k: StorageKnex['knex'], id: number, userId: number, otherId: number): Promise<void> {
  await k('output_baskets').insert({
    ...timestamp,
    basketId: id,
    userId: id === 2 ? otherId : userId,
    name: `basket-${id}`,
    isDeleted: id === 3
  })
  await k('outputs').insert({
    ...timestamp,
    outputId: id,
    userId: id === 2 ? otherId : userId,
    transactionId: id,
    basketId: id,
    spendable: false,
    change: true,
    vout: 0,
    satoshis: 1,
    providedBy: 'you',
    purpose: '',
    type: 'P2PKH',
    lockingScript: Buffer.from([id, 5, 255])
  })
  await k('commissions').insert({
    ...timestamp,
    commissionId: id,
    userId: id === 2 ? otherId : userId,
    transactionId: id,
    satoshis: 0,
    keyOffset: 'offset',
    isRedeemed: true,
    lockingScript: Buffer.from([id, 6, 255])
  })
  await k('output_tags').insert({
    ...timestamp,
    outputTagId: id,
    userId: id === 2 ? otherId : userId,
    tag: `tag-${id}`,
    isDeleted: id === 3
  })
  await k('output_tags_map').insert({ ...timestamp, outputTagId: id, outputId: id, isDeleted: id === 3 })
  await k('tx_labels').insert({
    ...timestamp,
    txLabelId: id,
    userId: id === 2 ? otherId : userId,
    label: `label-${id}`,
    isDeleted: id === 3
  })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: id, transactionId: id, isDeleted: id === 3 })
}
async function seedCertificates(k: StorageKnex['knex'], id: number, userId: number, otherId: number): Promise<void> {
  await k('certificates').insert({
    ...timestamp,
    certificateId: id,
    userId: id === 2 ? otherId : userId,
    serialNumber: `serial-${id}`,
    type: 'type',
    certifier: identity,
    subject: identity,
    revocationOutpoint: 'a'.repeat(64) + '.0',
    signature: 'signature',
    isDeleted: id === 3
  })
  for (const fieldName of ['a', 'Z', 'é', '😀'])
    await k('certificate_fields').insert({
      ...timestamp,
      certificateId: id,
      userId: id === 2 ? otherId : userId,
      fieldName,
      fieldValue: `value-${id}`,
      masterKey: 'key'
    })
}
async function seedStates(k: StorageKnex['knex'], id: number, userId: number, otherId: number): Promise<void> {
  await k('sync_states').insert({
    ...timestamp,
    syncStateId: id,
    userId: id === 2 ? otherId : userId,
    storageIdentityKey: `peer-${id}`,
    storageName: `peer-${id}`,
    status: 'unknown',
    init: true,
    refNum: `state-${id}`,
    syncMap: '{}',
    when: date
  })
}
async function seedClosure(source: StorageKnex, userId: number, otherId: number): Promise<void> {
  const k = source.knex
  await k('output_baskets').del()
  for (const id of [1, 2, 3]) {
    await seedProofs(k, id, userId, otherId)
    await seedOutputs(k, id, userId, otherId)
    await seedCertificates(k, id, userId, otherId)
    await seedStates(k, id, userId, otherId)
  }

  // Composite positions must handle repeated first keys and preserve deleted mappings.
  await k('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 3, isDeleted: true })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 3, isDeleted: true })
}

test('actual thirteen-table WAL capture matches the independent original exporter including portable map and locale order', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source
    .knex('proven_tx_reqs')
    .where({ provenTxReqId: 1 })
    .update({ history: '{"notes":[{"what":"original","when":null,"code":0}]}', notify: '{"transactionIds":null}' })
  const original = await exportBRC38(source, identity, { requireSnapshot: true })
  const captured = await archive(source, original.exportedAt)
  expect(captured).toEqual(original)
  expect(Object.values(captured.tables).every(rows => rows.length > 0)).toBe(true)
  expect(captured.tables.outputTagMaps.map(row => [row.outputId, row.outputTagId])).toEqual([
    [1, 1],
    [3, 1],
    [3, 3]
  ])
  expect(captured.tables.txLabelMaps.map(row => [row.transactionId, row.txLabelId])).toEqual([
    [1, 1],
    [3, 1],
    [3, 3]
  ])
  expect(captured.tables.certificateFields.filter(row => row.certificateId === 1).map(row => row.fieldName)).toEqual(
    ['a', 'Z', 'é', '😀'].sort((first, second) => first.localeCompare(second))
  )
  expect(captured.tables.provenTxs.map(row => row.provenTxId)).toEqual([1, 3])
  expect(captured.tables.syncStates.map(row => row.storageIdentityKey)).toEqual(['peer-1', 'peer-3'])
})

test('an independent WAL writer can commit while every archive table and original primary history remain in one source view', async () => {
  const { source, writer, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const original = await exportBRC38(source, identity, { requireSnapshot: true })
  const owner = await openBrc38KnexSource(source, identity, options)
  await writer.transaction(async trx => {
    await writer.updateUser(userId, { activeStorage: 'later-primary', updated_at: new Date() }, trx)
    await writer.updateTxLabel(1, { label: 'later-label' }, trx)
    await writer.updateSyncState(1, { syncMap: '{"transaction":{"count":99,"idMap":{}}}' }, trx)
  })
  const stream = await createBrc38Stream(owner, {
    exportedAt: original.exportedAt,
    maximumArchiveBytes: 1048576,
    maximumRowBytes: 65536,
    maximumChunkBytes: 64
  })
  try {
    expect(parseBRC38Json((await collect(stream.chunks)).toString())).toEqual(original)
    await stream.validateCompleted()
  } finally {
    await stream.close()
  }
  expect((await writer.findUserByIdentityKey(identity))?.activeStorage).toBe('later-primary')
  expect((await writer.findTxLabels({ partial: { txLabelId: 1 } }))[0].label).toBe('later-label')
})

test('a source orphan refuses during opening and awaits physical close', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source.knex('outputs').where({ outputId: 1 }).update({ basketId: 2 })
  const open = source.openReadSnapshot.bind(source)
  let closed = false
  jest.spyOn(source, 'openReadSnapshot').mockImplementationOnce(async selected => {
    const view = await open(selected),
      close = view.close
    return {
      ...view,
      close: async () => {
        try {
          await close()
        } finally {
          closed = true
        }
      }
    }
  })
  await expect(openBrc38KnexSource(source, identity, options)).rejects.toThrow('cross-profile')
  expect(closed).toBe(true)
})

test('large stored payloads refuse before the driver fetches them and clean up the source', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source
    .knex('proven_txs')
    .where({ provenTxId: 1 })
    .update({ rawTx: Buffer.alloc(65536) })
  const queries: string[] = []
  source.knex.on('query', (query: { sql: string }) => queries.push(query.sql))
  await expect(archive(source, date, { ...options, maximumPageBytes: 32768 })).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
  expect(queries.some(query => query.includes('`proven_txs`.*'))).toBe(false)
})

test('certificate groups refuse at the explicit allocation bound without completing a partial archive', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await expect(archive(source, date, { ...options, maximumCertificateGroupBytes: 1200 })).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
})

test('table operations refuse concurrent consumption, duplication and incomplete source validation', async () => {
  const { source } = await fixture(),
    owner = await openBrc38KnexSource(source, identity, options)
  try {
    await expect(owner.validateCompleted()).rejects.toThrow('did not complete')
    const first = owner.rows('outputBaskets')[Symbol.asyncIterator]()
    await first.next()
    const second = owner.rows('txLabels')[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toThrow('one complete read')
    await first.return?.()
    const consumed = []
    for await (const row of owner.rows('txLabels')) consumed.push(row)
    expect(consumed).toEqual([])
    const duplicate = owner.rows('txLabels')[Symbol.asyncIterator]()
    await expect(duplicate.next()).rejects.toThrow('one complete read')
  } finally {
    await owner.release()
  }
})

test('opening error and physical close failure both retain exact causes', async () => {
  const { source } = await fixture(),
    problem = new Error('header failed'),
    cleanup = new Error('close failed')
  const open = source.openReadSnapshot.bind(source)
  jest.spyOn(source, 'openReadSnapshot').mockImplementationOnce(async selected => {
    const view = await open(selected)
    return {
      ...view,
      read: async () => {
        throw problem
      },
      close: async () => {
        await view.close()
        throw cleanup
      }
    }
  })
  let error: unknown
  try {
    await openBrc38KnexSource(source, identity, options)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([problem, cleanup])
  expect((error as AggregateError).cause).toBe(problem)
})

test.each([
  'maximumPageRows',
  'maximumPageBytes',
  'maximumRowAllocationBytes',
  'maximumCertificateGroupBytes'
] as const)('invalid %s refuses before source acquisition', async name => {
  const { source } = await fixture(),
    open = jest.spyOn(source, 'openReadSnapshot')
  await expect(openBrc38KnexSource(source, identity, { ...options, [name]: 0 })).rejects.toThrow(RangeError)
  expect(open).not.toHaveBeenCalled()
})

test('generated bounded keyset sizes preserve the complete original thirteen-table archive', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const original = await exportBRC38(source, identity, { requireSnapshot: true })
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 16 }), async maximumPageRows => {
      const captured = await archive(source, original.exportedAt, { ...options, maximumPageRows })
      expect(captured).toEqual(original)
    }),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)

test.each([
  ['é', 'e\u0301'],
  ['e\u0301', 'é']
])('locale-equal distinct field names preserve the original SQLite exporter order (%#)', async (first, second) => {
  expect(first.localeCompare(second)).toBe(0)
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source.knex('certificate_fields').where({ certificateId: 1 }).del()
  await runInSeries([first, second], fieldName =>
    source
      .knex('certificate_fields')
      .insert({
        ...timestamp,
        certificateId: 1,
        userId,
        fieldName,
        fieldValue: fieldName,
        masterKey: 'original'
      })
      .then(() => undefined)
  )
  const original = await exportBRC38(source, identity, { requireSnapshot: true })
  expect(await archive(source, original.exportedAt)).toEqual(original)
})

test.each(['table', 'reverse-table', 'descending-index', 'reverse-index'] as const)(
  'locale ties retain the legacy finder with %s scan',
  async mode => {
    // Build the actual pre-generation schema; removing a bound live index
    // correctly refuses admission and cannot represent a legacy provider.
    const { source, userId, otherId } = await fixture(true)
    await seedClosure(source, userId, otherId)
    await source.knex('certificate_fields').where({ certificateId: 1 }).del()
    await source.knex.raw('DROP INDEX IF EXISTS brc38_import_target_certificateFields')
    if (mode.endsWith('index'))
      await source.knex.raw('CREATE INDEX ?? ON certificate_fields(userId, fieldName DESC, certificateId)', [
        'legacy "descending" finder (fixture)'
      ])
    if (mode.startsWith('reverse')) await source.knex.raw('PRAGMA reverse_unordered_selects = ON')
    for (const names of [
      ['é', 'e\u0301'],
      ['e\u0301', 'é']
    ]) {
      await source.knex('certificate_fields').where({ certificateId: 1 }).del()
      await runInSeries(names, fieldName =>
        source
          .knex('certificate_fields')
          .insert({
            ...timestamp,
            certificateId: 1,
            userId,
            fieldName,
            fieldValue: fieldName,
            masterKey: 'original'
          })
          .then(() => undefined)
      )
      const query = source.findCertificateFieldsQuery({ partial: { userId } }).toSQL(),
        plan: Array<{ detail: string }> = await source.knex.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
      expect(plan).toHaveLength(1)
      expect(plan[0].detail).toContain(
        mode.endsWith('index') ? 'legacy "descending" finder (fixture)' : 'SCAN certificate_fields'
      )
      const original = await exportBRC38(source, identity, { requireSnapshot: true })
      expect(original.tables.provenTxReqs[0].wasBroadcast).toBe(1)
      expect(await archive(source, original.exportedAt)).toEqual(original)
    }
  }
)

test.each([
  ['maximumPageRows', 1000],
  ['maximumPageBytes', 16777216],
  ['maximumRowAllocationBytes', 16777216],
  ['maximumCertificateGroupBytes', 16777216],
  ['maximumMetadataAllocationBytes', 65536]
] as const)(
  '%s validates every refusal boundary before acquisition and admits its exact maximum',
  async (name, maximum) => {
    const cause = new Error('Synthetic acquisition boundary'),
      openReadSnapshot = jest.fn(async () => {
        throw cause
      }),
      source = { openReadSnapshot } as unknown as StorageKnex
    for (const value of [0, -1, 1.5, NaN, Infinity, maximum + 1])
      await expect(openBrc38KnexSource(source, identity, { ...options, [name]: value })).rejects.toThrow(RangeError)
    expect(openReadSnapshot).not.toHaveBeenCalled()
    await expect(openBrc38KnexSource(source, identity, { ...options, [name]: maximum })).rejects.toBe(cause)
    expect(openReadSnapshot).toHaveBeenCalledTimes(1)
  }
)
test.each(['', '04' + '11'.repeat(32), '02' + '11'.repeat(31), '02' + 'gg'.repeat(32), identity + '0'])(
  'invalid compressed identity refuses before acquiring a provider: %s',
  async selected => {
    const openReadSnapshot = jest.fn(),
      source = { openReadSnapshot } as unknown as StorageKnex
    await expect(openBrc38KnexSource(source, selected, options)).rejects.toThrow(/Compressed profile identity/)
    expect(openReadSnapshot).not.toHaveBeenCalled()
  }
)
test('pre-aborted ownership refuses acquisition with the exact original cancellation cause', async () => {
  const cause = new Error('Synthetic pre-acquisition cancellation'),
    controller = new AbortController(),
    openReadSnapshot = jest.fn(),
    source = { openReadSnapshot } as unknown as StorageKnex
  controller.abort(cause)
  await expect(openBrc38KnexSource(source, identity, { ...options, signal: controller.signal })).rejects.toBe(cause)
  expect(openReadSnapshot).not.toHaveBeenCalled()
})
test('unknown table refusal keeps a real retained source available for its original table and idempotent close', async () => {
  const { source } = await fixture(),
    owner = await openBrc38KnexSource(source, identity, options)
  try {
    await expect(
      owner
        .rows('unknown' as Parameters<typeof owner.rows>[0])
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toThrow(/Unknown BRC-38 source table/)
    const iterator = owner.rows('provenTxs')[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(owner.rows('provenTxs')[Symbol.asyncIterator]().next()).rejects.toThrow(/one complete read/)
    await expect(owner.validateCompleted()).rejects.toThrow(/did not complete/)
  } finally {
    await owner.release()
    await owner.release()
  }
})

// Additive integration cases for the explicit native large-binary path. Original
// canonical-order and independent property bodies above remain unchanged.
const streamedOptions: Brc38KnexSourceOptions = {
  ...options,
  maximumPageRows: 2,
  maximumPageBytes: 65536,
  streamedBinary: { maximumBinaryBytes: 2097152, maximumExtentBytes: 65536 }
}
const streamedEncoderOptions = {
  maximumArchiveBytes: 16777216,
  maximumRowBytes: 65536,
  maximumChunkBytes: 65536,
  streamedRows: { maximumMetadataAllocationBytes: 65536, maximumBinaryBytes: 2097152, maximumRowBytes: 4194304 }
}
async function streamedArchiveChunks(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = []
  for await (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(65536)
    values.push(chunk)
  }
  // Whole-document allocation is confined to this finite independent oracle.
  return Buffer.concat(values)
}
test('native streamed binary retains all thirteen canonical tables and a large original WAL value across concurrent writes', async () => {
  const { source, writer, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const blob = Buffer.alloc(1048576, 37)
  await source
    .knex('transactions')
    .where({ transactionId: 1 })
    .update({ rawTx: blob, noSendExpiryReclaimRawTx: Buffer.alloc(131072, 37) })
  const original = await exportBRC38(source, identity, { requireSnapshot: true })
  const owner = await openBrc38KnexSource(source, identity, streamedOptions)
  const sql: string[] = []
  const observe = ({ sql: text }: { sql: string }) => {
    if (sql.length < 500) sql.push(text)
  }
  source.knex.on('query', observe)
  await writer
    .knex('transactions')
    .where({ transactionId: 1 })
    .update({ rawTx: Buffer.alloc(1048576, 91) })
  const stream = await createBrc38Stream(owner, { ...streamedEncoderOptions, exportedAt: original.exportedAt })
  try {
    const bytes = await streamedArchiveChunks(stream.chunks)
    expect(parseBRC38Json(bytes.toString())).toEqual(original)
    await stream.validateCompleted()
    expect(sql.some(query => /substr\(/i.test(query))).toBe(true)
    expect(sql.some(query => /select[^;]*[`"]?transactions[`"]?\.\*/i.test(query))).toBe(false)
  } finally {
    source.knex.off('query', observe)
    await stream.close()
  }
  expect((await writer.knex('transactions').where({ transactionId: 1 }).first('rawTx')).rawTx[0]).toBe(91)
})
test('native binary references cease to read when their canonical row advances or the source closes', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const owner = await openBrc38KnexSource(source, identity, streamedOptions)
  const iterator = owner.streamedRows!('transactions')[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const reference = first.value!.binaries.rawTx
    expect(await reference.read(0, 1)).toEqual(Uint8Array.from([1]))
    await iterator.next()
    await expect(reference.read(0, 1)).rejects.toThrow('row lifetime')
    await iterator.return?.()
    await owner.release()
    await expect(reference.read(0, 1)).rejects.toThrow('closed or expired')
  } finally {
    await iterator.return?.()
    await owner.release()
  }
})
test('native streamed binary policy refuses before any binary extent or whole-row payload fetch', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source
    .knex('transactions')
    .where({ transactionId: 1 })
    .update({ rawTx: Buffer.alloc(1048576) })
  const owner = await openBrc38KnexSource(source, identity, {
    ...streamedOptions,
    streamedBinary: { maximumBinaryBytes: 1000 }
  })
  const sql: string[] = []
  const observe = ({ sql: text }: { sql: string }) => {
    sql.push(text)
  }
  source.knex.on('query', observe)
  const iterator = owner.streamedRows!('transactions')[Symbol.asyncIterator]()
  let failure: unknown
  try {
    try {
      await iterator.next()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SnapshotResourceLimitError)
    expect(sql.some(query => /substr\(/i.test(query))).toBe(false)
    expect(sql.some(query => /select[^;]*[`"]?transactions[`"]?\.\*/i.test(query))).toBe(false)
    await expect(owner.validateCompleted()).rejects.toThrow('did not complete')
  } finally {
    source.knex.off('query', observe)
    await iterator.return?.()
    // The failed retained read owns its actual terminal error through physical
    // drain; accepting that exact error cannot hide secondary cleanup failure.
    if (failure instanceof SnapshotResourceLimitError) await expect(owner.release()).rejects.toBe(failure)
    else await owner.release()
  }
})
