import { knex, type Knex } from 'knex'
import { loadSnapshotIdMap, detachSnapshotSyncPage } from './SnapshotSyncRows'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type { SnapshotSyncCheckpoint, SnapshotSyncTable } from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'

let database: Knex
const scope = { userId: 10, sourceStorageIdentityKey: 'source' }
beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await database.schema.createTable('snapshot_sync_ids', table => {
    table.integer('userId')
    table.string('sourceStorageIdentityKey')
    table.string('entity')
    table.integer('incomingId')
    table.integer('localId')
    table.primary(['userId', 'sourceStorageIdentityKey', 'entity', 'incomingId'])
  })
})
afterEach(async () => {
  await database.destroy()
})
function chunk(table: SnapshotSyncTable, rows: unknown[]): SyncChunk {
  return {
    userIdentityKey: 'identity',
    fromStorageIdentityKey: 'source',
    toStorageIdentityKey: 'destination',
    [table]: rows
  } as SyncChunk
}

test('ID lookup is profile/source scoped, maps parents and persists only newly learned IDs', async () => {
  await database('snapshot_sync_ids').insert([
    { ...scope, entity: 'transaction', incomingId: 1, localId: 101 },
    { ...scope, entity: 'outputBasket', incomingId: 2, localId: 102 },
    { ...scope, entity: 'output', incomingId: 3, localId: 103 },
    { ...scope, userId: 20, entity: 'transaction', incomingId: 1, localId: 999 },
    { ...scope, sourceStorageIdentityKey: 'other', entity: 'transaction', incomingId: 1, localId: 888 }
  ])
  const loaded = await loadSnapshotIdMap(
    database,
    scope,
    7,
    'outputs',
    chunk('outputs', [
      { outputId: 3, userId: 7, transactionId: 1, basketId: 2, spentBy: 1 },
      { outputId: 4, userId: 7, transactionId: 1, basketId: 2 }
    ])
  )
  expect(loaded.map.transaction.idMap).toEqual({ 1: 101 })
  expect(loaded.map.outputBasket.idMap).toEqual({ 2: 102 })
  expect(loaded.map.output.idMap).toEqual({ 3: 103 })
  loaded.map.output.idMap[4] = 104
  await loaded.persist()
  expect(
    await database('snapshot_sync_ids')
      .where({ ...scope, entity: 'output' })
      .orderBy('incomingId')
  ).toEqual([
    { ...scope, entity: 'output', incomingId: 3, localId: 103 },
    { ...scope, entity: 'output', incomingId: 4, localId: 104 }
  ])
  expect(await database('snapshot_sync_ids')).toHaveLength(6)
})

test('mapping references are capped before SQL, while the exact bound permits bounded lookup batches', async () => {
  const notify = (count: number) =>
    chunk('provenTxReqs', [
      { provenTxReqId: 1, notify: JSON.stringify({ transactionIds: Array.from({ length: count }, (_, n) => n + 1) }) }
    ])
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  database.on('query', query => queries.push(query))
  await expect(loadSnapshotIdMap(database, scope, 7, 'provenTxReqs', notify(4096))).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
  expect(queries).toHaveLength(0)
  const accepted = await loadSnapshotIdMap(database, scope, 7, 'provenTxReqs', notify(4095))
  expect(queries).toHaveLength(33)
  expect(queries.every(query => query.bindings.length <= 131)).toBe(true)
  // Unmapped notifications can refer to another profile and are not fabricated.
  expect(accepted.map.transaction.idMap).toEqual({})
  await accepted.persist()
  expect(queries).toHaveLength(33)
})

test('missing parent mappings and invalid notification IDs cannot produce a partial map', async () => {
  await expect(
    loadSnapshotIdMap(
      database,
      scope,
      7,
      'transactions',
      chunk('transactions', [{ userId: 7, transactionId: 1, provenTxId: 2 }])
    )
  ).rejects.toThrow('parent mapping is missing')
  for (const transactionIds of [1, {}, [0], [-1], [1.5], ['1']])
    await expect(
      loadSnapshotIdMap(
        database,
        scope,
        7,
        'provenTxReqs',
        chunk('provenTxReqs', [{ provenTxReqId: 1, notify: JSON.stringify({ transactionIds }) }])
      )
    ).rejects.toThrow()
  expect(await database('snapshot_sync_ids')).toHaveLength(0)
})

test('packed row admission refuses non-record rows and extra allocation before copying', () => {
  const checkpoint: SnapshotSyncCheckpoint = {
    version: 1,
    sessionId: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    identityKey: 'identity',
    sourceStorageIdentityKey: 'source',
    destinationStorageIdentityKey: 'destination',
    tableIndex: 3,
    sequence: 3,
    done: false
  }
  const page = (row: unknown): WalletSnapshotPage<'txLabels'> =>
    ({
      rows: [row],
      payloadBytes: 8192,
      done: true,
      cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'txLabels', after: [1] }
    }) as WalletSnapshotPage<'txLabels'>
  for (const row of [null, 1, Object.fromEntries(Array.from({ length: 65 }, (_, n) => ['column' + n, n]))])
    expect(() => detachSnapshotSyncPage(checkpoint, page(row))).toThrow('flat snapshot records')
  expect(() =>
    detachSnapshotSyncPage(checkpoint, {
      rows: [],
      payloadBytes: 0,
      done: true,
      cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'txLabels', after: [1] }
    })
  ).toThrow('unchanged empty-page')
  const prior = { version: 1 as const, snapshotId: checkpoint.snapshotId, table: 'txLabels' as const, after: [1] }
  expect(
    detachSnapshotSyncPage({ ...checkpoint, cursor: prior }, { rows: [], payloadBytes: 0, done: true, cursor: prior })
  ).toMatchObject({ nextTable: 4, nextCursor: null })
  expect(() => detachSnapshotSyncPage({ ...checkpoint, cursor: prior }, page({ txLabelId: 1 }))).toThrow('last row')
})

const boundedCheckpoint: SnapshotSyncCheckpoint = {
  version: 1,
  sessionId: 'a'.repeat(64),
  snapshotId: 'b'.repeat(64),
  identityKey: 'identity',
  sourceStorageIdentityKey: 'source',
  destinationStorageIdentityKey: 'destination',
  tableIndex: 3,
  sequence: 3,
  done: false
}
function boundedPage(rows: unknown[], payloadBytes = 16777216): WalletSnapshotPage<'txLabels'> {
  const last = rows.at(-1) as { txLabelId: number } | undefined
  return {
    rows,
    done: true,
    payloadBytes,
    ...(last === undefined
      ? {}
      : {
          cursor: { version: 1, snapshotId: boundedCheckpoint.snapshotId, table: 'txLabels', after: [last.txLabelId] }
        })
  } as WalletSnapshotPage<'txLabels'>
}

test.each([
  [NaN, 'finite numbers'],
  [Infinity, 'finite numbers'],
  [new Date(NaN), 'finite dates'],
  [{ nested: true }, 'packed bytes, dates and scalar values'],
  [[1, 2], 'packed bytes, dates and scalar values']
])('allocation refuses unsupported value %p before cloning', (value, reason) => {
  expect(() => detachSnapshotSyncPage(boundedCheckpoint, boundedPage([{ txLabelId: 1, value }]))).toThrow(
    `The rows parameter must be ${reason}`
  )
})

test.each(['abc', new Uint8Array([1, 2, 3])])(
  'allocation charge covers each string or packed-byte payload %p',
  value => {
    // Two cells cost 128 bytes plus twice the three-unit payload.
    const page = boundedPage([{ txLabelId: 1, value }], 134)
    expect(detachSnapshotSyncPage(boundedCheckpoint, page).chunk.txLabels).toHaveLength(1)
    expect(() => detachSnapshotSyncPage(boundedCheckpoint, { ...page, payloadBytes: 133 })).toThrow(
      'The payloadBytes parameter must be an allocation charge covering every row'
    )
  }
)

test('inclusive row, column and byte ceilings accept their exact bounds', () => {
  const row = Object.fromEntries(Array.from({ length: 63 }, (_, n) => ['column' + n, n]))
  expect(
    detachSnapshotSyncPage(boundedCheckpoint, boundedPage([{ ...row, txLabelId: 1 }], 4096)).chunk.txLabels
  ).toHaveLength(1)
  const page = boundedPage(Array.from({ length: 1000 }, (_, n) => ({ txLabelId: n + 1 })))
  expect(detachSnapshotSyncPage(boundedCheckpoint, page).chunk.txLabels).toHaveLength(1000)
})

test.each([
  { rows: undefined },
  { rows: Array.from({ length: 1001 }, (_, n) => ({ txLabelId: n + 1 })) },
  { done: undefined },
  { payloadBytes: -1 },
  { payloadBytes: 0.5 },
  { payloadBytes: 16777217 },
  { rows: [], done: false }
])('invalid page envelope %p rejects at page admission', patch => {
  expect(() =>
    detachSnapshotSyncPage(boundedCheckpoint, { ...boundedPage([]), ...patch } as WalletSnapshotPage<'txLabels'>)
  ).toThrow('The page parameter must be a bounded snapshot page making progress')
})

test.each([{ tableIndex: 12 }, { done: true }])('complete checkpoints refuse pages before allocation: %p', patch => {
  expect(() => detachSnapshotSyncPage({ ...boundedCheckpoint, ...patch }, boundedPage([]))).toThrow(
    'Snapshot sync is already complete'
  )
})

test('composite cursors must match every final-row key and the original source view', () => {
  const checkpoint = { ...boundedCheckpoint, tableIndex: 6 }
  const page: WalletSnapshotPage<'txLabelMaps'> = {
    rows: [{ txLabelId: 1, transactionId: 2 } as never],
    done: false,
    payloadBytes: 128,
    cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'txLabelMaps', after: [1, 2] }
  }
  expect(detachSnapshotSyncPage(checkpoint, page).nextCursor).toBe(JSON.stringify(page.cursor))
  for (const after of [
    [1, 3],
    [3, 2]
  ])
    expect(() => detachSnapshotSyncPage(checkpoint, { ...page, cursor: { ...page.cursor!, after } })).toThrow(
      'The page.cursor parameter must be the last row of this source view and table'
    )
  for (const cursor of [undefined, { ...page.cursor!, snapshotId: 'c'.repeat(64) }])
    expect(() => detachSnapshotSyncPage(checkpoint, { ...page, cursor })).toThrow(
      'The page.cursor parameter must be the last row of this source view and table'
    )
})

test('mapping batches never exceed 128 new IDs or include another profile in a global row', async () => {
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  database.on('query', query => queries.push(query))
  const rows = Array.from({ length: 256 }, (_, n) => ({ userId: 7, txLabelId: n + 1 }))
  const loaded = await loadSnapshotIdMap(database, scope, 7, 'txLabels', chunk('txLabels', rows))
  expect(queries).toHaveLength(2)
  for (const row of rows) loaded.map.txLabel.idMap[row.txLabelId] = row.txLabelId + 1000
  await loaded.persist()
  const inserts = queries.filter(query => query.sql.startsWith('insert'))
  expect(inserts).toHaveLength(2)
  expect(inserts.every(query => query.bindings.length === 128 * 5)).toBe(true)
  expect(await database('snapshot_sync_ids')).toHaveLength(256)
  await expect(
    loadSnapshotIdMap(database, scope, 7, 'provenTxs', chunk('provenTxs', [{ provenTxId: 1, userId: 99 }]))
  ).rejects.toThrow('Snapshot row belongs to another profile')
})
