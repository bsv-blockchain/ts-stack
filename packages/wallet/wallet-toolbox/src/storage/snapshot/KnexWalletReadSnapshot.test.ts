import { removeSnapshotProfileIndexes, SNAPSHOT_PROFILE_INDEX_MIGRATION } from '../schema/snapshotProfileIndexMigration'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type {
  WalletSnapshotCursor,
  WalletSnapshotTable,
  WalletReadSnapshot,
  PackedSnapshotRow,
  WalletSnapshotTables
} from './WalletReadSnapshot'
import { runInSeries } from '../../utility/runInSeries'
import { createKnexWalletSnapshotPageReader, walletSnapshotSourceQuery } from './KnexWalletReadSnapshot'
import {
  removeSnapshotRelationIndexes,
  SNAPSHOT_RELATION_INDEX_MIGRATION
} from '../schema/snapshotRelationIndexMigration'

const identity = '02' + '11'.repeat(32)
const foreignIdentity = '03' + '22'.repeat(32)
const date = '2026-01-01T00:00:00.000Z'
const timestamp = { created_at: date, updated_at: date }
const stores: StorageKnex[] = []
const directories: string[] = []

async function fixture(): Promise<{ source: StorageKnex; writer: StorageKnex; userId: number; otherId: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-keyset-'))
  directories.push(directory)
  const open = () => {
    const store = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(store)
    return store
  }
  const source = open()
  await source.knex.raw('PRAGMA journal_mode = WAL')
  await source.migrate('keyset source', 'source-storage')
  await source.makeAvailable()
  const { user } = await source.findOrInsertUser(identity)
  const { user: other } = await source.findOrInsertUser(foreignIdentity)
  const writer = open()
  await writer.makeAvailable()
  return { source, writer, userId: user.userId, otherId: other.userId }
}

async function labels(source: StorageKnex, userId: number, count: number): Promise<void> {
  await runInSeries(
    Array.from({ length: count }, (_, index) => index),
    async index => {
      await source.knex('tx_labels').insert({
        ...timestamp,
        userId,
        label: `label-${index}`,
        isDeleted: index % 3 === 0
      })
    }
  )
}

async function all<T extends WalletSnapshotTable>(
  view: WalletReadSnapshot,
  table: T
): Promise<Array<PackedSnapshotRow<WalletSnapshotTables[T]>>> {
  const rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
  let cursor: WalletSnapshotCursor | undefined
  for (;;) {
    const page = await view.readPage(table, cursor, { maxRows: 1 })
    rows.push(...page.rows)
    if (page.done) return rows
    expect(page.cursor).toBeDefined()
    cursor = page.cursor
  }
}

afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(stores.splice(0), source => source.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('omitted auxiliary-index arguments preserve legacy profile queries and retained pages before migration', async () => {
  const { source, userId, otherId } = await fixture()
  await removeSnapshotProfileIndexes(source.knex)
  await source.knex('knex_migrations').where('name', SNAPSHOT_PROFILE_INDEX_MIGRATION).delete()
  await removeSnapshotRelationIndexes(source.knex)
  await source.knex('knex_migrations').where('name', SNAPSHOT_RELATION_INDEX_MIGRATION).delete()
  await labels(source, userId, 2)
  await labels(source, otherId, 2)
  const expected = await source.findTxLabels({ partial: { userId } })
  const view = await source.openReadSnapshot()
  try {
    const selected = await view.read(trx =>
      walletSnapshotSourceQuery(source.toDb(trx), 'txLabels', userId).select('txLabelId').orderBy('txLabelId')
    )
    expect(selected).toEqual(expected.map(({ txLabelId }) => ({ txLabelId })))
    const reader = createKnexWalletSnapshotPageReader(source, userId, '12'.repeat(32), view)
    const page = await reader('txLabels', undefined, { maxRows: 10 })
    expect(page.rows).toEqual(expected)
    expect(page.done).toBe(true)
    expect(page.cursor?.after).toEqual([expected.at(-1)!.txLabelId])
    expect(
      await view.read(trx => walletSnapshotSourceQuery(source.toDb(trx), 'txLabelMaps', userId).select('*'))
    ).toEqual([])
    expect((await reader('txLabelMaps')).rows).toEqual([])
  } finally {
    await view.close()
  }
})

test('keyset pages pin profile, source metadata, equal timestamps and tombstones across independent writes', async () => {
  const { source, writer, userId, otherId } = await fixture()
  await labels(source, userId, 9)
  await labels(source, otherId, 9)
  const expected = await source.findTxLabels({ partial: { userId } })
  await writer.knex('settings').update({ storageName: 'uncached name' })
  expect(source.getSettings().storageName).toBe('keyset source')
  const view = await source.openWalletReadSnapshot(identity)
  expect(view.version).toBe(1)
  expect(view.snapshotId).toMatch(/^[a-f0-9]{64}$/)
  expect(view.sourceStorage.storageName).toBe('uncached name')
  expect(view.user.userId).toBe(userId)
  expect(view.isOpen).toBe(true)
  await writer.knex('tx_labels').where({ txLabelId: expected[0].txLabelId }).update({ label: 'new value' })
  await writer.knex('tx_labels').where({ txLabelId: expected[4].txLabelId }).del()
  await writer.findOrInsertTxLabel(userId, 'new row')
  await writer.knex('users').where({ userId }).update({ activeStorage: 'new primary' })
  const first = await view.readPage('txLabels', undefined, { maxRows: 3 })
  expect(first.rows).toEqual(expected.slice(0, 3))
  expect(first.done).toBe(false)
  expect(await view.readPage('txLabels', undefined, { maxRows: 3 })).toEqual(first)
  // Returned metadata is descriptive; mutating it cannot change the bound query.
  view.user.userId = otherId
  const next = await view.readPage('txLabels', first.cursor, { maxRows: 3 })
  expect(next.rows).toEqual(expected.slice(3, 6))
  expect(await all(view, 'txLabels')).toEqual(expected)
  await view.close()
  await view.closed
  expect(view.isOpen).toBe(false)
  await expect(view.readPage('txLabels')).rejects.toThrow('closed')
  const fresh = await source.openWalletReadSnapshot(identity)
  expect(fresh.user.activeStorage).toBe('new primary')
  await expect(fresh.readPage('txLabels', first.cursor)).rejects.toThrow('cursor')
  expect(await all(fresh, 'txLabels')).not.toEqual(expected)
  await fresh.close()
})

test('byte preflight stops before an oversized row without loading its payload or skipping it', async () => {
  const { source, userId } = await fixture()
  await labels(source, userId, 2)
  await source.knex('tx_labels').insert({ ...timestamp, userId, label: 'x'.repeat(500000), isDeleted: false })
  const view = await source.openWalletReadSnapshot(identity)
  const first = await view.readPage('txLabels', undefined, { maxRows: 1 })
  const second = await view.readPage('txLabels', first.cursor, { maxRows: 1, maxBytes: first.payloadBytes })
  expect(second.rows).toHaveLength(1)
  const bounded = await view.readPage('txLabels', undefined, { maxRows: 3, maxBytes: first.payloadBytes * 2 })
  expect(bounded.rows).toHaveLength(2)
  expect(bounded.payloadBytes).toBe(first.payloadBytes * 2)
  expect(bounded.done).toBe(false)
  const queries: string[] = []
  source.knex.on('query', q => queries.push(q.sql))
  await expect(view.readPage('txLabels', second.cursor)).rejects.toThrow('row exceeds maxBytes')
  await expect(view.closed).rejects.toThrow('row exceeds maxBytes')
  expect(queries.filter(sql => /select/i.test(sql))).toHaveLength(1)
  expect(queries[0]).toContain('length(cast(')
  expect(queries[0]).not.toContain('`tx_labels`.*')
  expect(queries[0]).not.toMatch(/offset|count\(/i)
  const next = await source.openWalletReadSnapshot(identity)
  expect((await next.readPage('txLabels', undefined, { maxRows: 3, maxBytes: 2000000 })).rows).toHaveLength(3)
  await next.close()
})

test.each([
  { maxRows: 0 },
  { maxRows: -1 },
  { maxRows: 1.5 },
  { maxRows: 1001 },
  { maxRows: NaN },
  { maxBytes: 0 },
  { maxBytes: -1 },
  { maxBytes: 1.5 },
  { maxBytes: 16777217 },
  { maxBytes: Infinity }
])('rejects invalid allocation limits before executing SQL: %j', async limits => {
  const { source } = await fixture()
  const view = await source.openWalletReadSnapshot(identity)
  const read = jest.spyOn(source, 'toDb')
  await expect(view.readPage('txLabels', undefined, limits)).rejects.toThrow('integer')
  expect(read).not.toHaveBeenCalled()
  expect(view.isOpen).toBe(true)
  await view.close()
})

test('rejects table and cursor confusion before querying and detaches caller cursors', async () => {
  const { source, userId } = await fixture()
  await labels(source, userId, 3)
  const view = await source.openWalletReadSnapshot(identity)
  const { cursor } = await view.readPage('txLabels', undefined, { maxRows: 1 })
  const read = jest.spyOn(source, 'toDb')
  for (const table of ['settings', 'users', '__proto__', 'constructor', 'tx_labels']) {
    await expect(view.readPage(table as WalletSnapshotTable)).rejects.toThrow('table')
  }
  for (const invalid of [
    null,
    { ...cursor, version: 2 },
    { ...cursor, snapshotId: 'different' },
    { ...cursor, table: 'outputs' },
    { ...cursor, after: [] },
    { ...cursor, after: [0] },
    { ...cursor, after: [-1] },
    { ...cursor, after: [1.1] },
    { ...cursor, after: ['1'] },
    { ...cursor, after: [Number.MAX_SAFE_INTEGER + 1] },
    { ...cursor, after: [1, 2] },
    { ...cursor, after: {} }
  ])
    await expect(view.readPage('txLabels', invalid as WalletSnapshotCursor)).rejects.toThrow('cursor')
  expect(read).not.toHaveBeenCalled()
  const mutable = { ...cursor!, after: [...cursor!.after] }
  const pending = view.readPage('txLabels', mutable)
  mutable.after[0] = 99999
  expect((await pending).rows).toHaveLength(2)
  await view.close()
})

test('unsupported providers and invalid identities refuse explicitly and failed opening releases its slot', async () => {
  const idb = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  expect(idb.supportsWalletReadSnapshot()).toBe(false)
  await expect(idb.openWalletReadSnapshot(identity)).rejects.toThrow('not supported')
  const { source } = await fixture()
  expect(source.supportsWalletReadSnapshot()).toBe(true)
  const read = jest.spyOn(source, 'openReadSnapshot')
  for (const key of [
    '',
    '04' + '11'.repeat(32),
    '02' + 'gg'.repeat(32),
    'x' + identity,
    identity + 'x',
    { toString: () => identity } as unknown as string
  ]) {
    await expect(source.openWalletReadSnapshot(key)).rejects.toThrow('identityKey')
  }
  expect(read).not.toHaveBeenCalled()
  await expect(source.openWalletReadSnapshot('02' + '33'.repeat(32))).rejects.toThrow('existing wallet profile')
  const view = await source.openWalletReadSnapshot(identity)
  await view.close()
  jest.spyOn(source, 'supportsRetainedReadSnapshot').mockReturnValue(false)
  expect(source.supportsWalletReadSnapshot()).toBe(false)
  await expect(source.openWalletReadSnapshot(identity)).rejects.toThrow('not supported')
})

async function seedClosure(source: StorageKnex, userId: number, otherId: number): Promise<void> {
  const k = source.knex
  await k('output_baskets').del()
  for (const id of [1, 2, 3]) {
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
  // Composite positions must handle repeated first keys and preserve deleted mappings.
  await k('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 3, isDeleted: true })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 3, isDeleted: true })
}

test('all thirteen tables retain original rows, packed binary and composite key order without foreign profiles', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const view = await source.openWalletReadSnapshot(identity)
  const cases: Array<[WalletSnapshotTable, string, number[]]> = [
    ['provenTxs', 'provenTxId', [1, 3]],
    ['provenTxReqs', 'provenTxReqId', [1, 3]],
    ['outputBaskets', 'basketId', [1, 3]],
    ['transactions', 'transactionId', [1, 3]],
    ['outputs', 'outputId', [1, 3]],
    ['commissions', 'commissionId', [1, 3]],
    ['outputTags', 'outputTagId', [1, 3]],
    ['txLabels', 'txLabelId', [1, 3]],
    ['certificates', 'certificateId', [1, 3]],
    ['syncStates', 'syncStateId', [1, 3]]
  ]
  for (const [table, key, ids] of cases) {
    const rows = (await all(view, table)) as unknown as Array<Record<string, unknown>>
    expect(rows.map(row => row[key])).toEqual(ids)
    for (const row of rows) {
      expect(row.created_at).toEqual(new Date(date))
      expect(row.updated_at).toEqual(new Date(date))
      if ('userId' in row) expect(row.userId).toBe(userId)
      for (const flag of [
        'isDeleted',
        'isOutgoing',
        'isRedeemed',
        'spendable',
        'change',
        'notified',
        'wasBroadcast',
        'init'
      ]) {
        if (flag in row) expect(typeof row[flag]).toBe('boolean')
      }
      for (const binary of ['rawTx', 'inputBEEF', 'merklePath', 'lockingScript']) {
        if (row[binary] !== undefined) {
          expect(row[binary]).toBeInstanceOf(Uint8Array)
          expect(Array.isArray(row[binary])).toBe(false)
          expect((row[binary] as Uint8Array)[2]).toBe(255)
          expect((row[binary] as Uint8Array).buffer.byteLength).toBe((row[binary] as Uint8Array).byteLength)
        }
      }
    }
  }
  expect((await all(view, 'txLabelMaps')).map(row => [row.txLabelId, row.transactionId, row.isDeleted])).toEqual([
    [1, 1, false],
    [1, 3, true],
    [3, 3, true]
  ])
  expect((await all(view, 'outputTagMaps')).map(row => [row.outputTagId, row.outputId, row.isDeleted])).toEqual([
    [1, 1, false],
    [1, 3, true],
    [3, 3, true]
  ])
  expect((await all(view, 'certificateFields')).map(row => [row.fieldName, row.certificateId])).toEqual(
    ['Z', 'a', 'é', '😀'].flatMap(field => [
      [field, 1],
      [field, 3]
    ])
  )
  const states = await view.readPage('syncStates')
  expect(states.rows[0].init).toBe(true)
  expect(states.rows[0].when).toEqual(new Date(date))
  expect(states.rows[0].syncMap).toBe('{}')
  const proof = await view.readPage('provenTxs')
  proof.rows[0].rawTx[0] = 99
  expect((await view.readPage('provenTxs')).rows[0].rawTx[0]).toBe(1)
  await view.close()
})

test.each(['txLabelMaps', 'outputTagMaps', 'certificateFields'] as const)(
  'inconsistent owned relationships reject instead of leaking or silently dropping a row: %s',
  async table => {
    const { source, userId, otherId } = await fixture()
    await seedClosure(source, userId, otherId)
    if (table === 'txLabelMaps')
      await source.knex('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 2 })
    if (table === 'outputTagMaps')
      await source.knex('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 2 })
    if (table === 'certificateFields')
      await source.knex('certificate_fields').where({ certificateId: 2 }).update({ userId })
    const view = await source.openWalletReadSnapshot(identity)
    await expect(view.readPage(table)).rejects.toThrow('does not belong')
    await expect(view.closed).rejects.toThrow('does not belong')
  }
)

test('certificate keys preserve empty, embedded-NUL and 100-code-point names with bounded cursor validation', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  const names = ['', 'a\0x', 'a\0y', '😀'.repeat(100)]
  for (const fieldName of names)
    await source.knex('certificate_fields').insert({
      ...timestamp,
      userId,
      certificateId: 1,
      fieldName,
      fieldValue: 'value',
      masterKey: 'key'
    })
  const view = await source.openWalletReadSnapshot(identity)
  const rows = await all(view, 'certificateFields')
  for (const name of names) expect(rows.some(row => row.fieldName === name)).toBe(true)
  expect(rows).toHaveLength(12)
  for (const fieldName of [100, 'a'.repeat(101), '😀'.repeat(101)]) {
    await expect(
      view.readPage('certificateFields', {
        version: 1,
        snapshotId: view.snapshotId,
        table: 'certificateFields',
        after: [fieldName, 1]
      })
    ).rejects.toThrow('cursor')
  }
  await view.close()
})

test.each(['a'.repeat(101), 'a'.repeat(401)])(
  'oversized stored certificate key rejects without loading its row (%#)',
  async fieldName => {
    const { source, userId, otherId } = await fixture()
    await seedClosure(source, userId, otherId)
    await source.knex('certificate_fields').del()
    await source
      .knex('certificate_fields')
      .insert({ ...timestamp, userId, certificateId: 1, fieldName, fieldValue: 'x'.repeat(500000), masterKey: 'key' })
    const view = await source.openWalletReadSnapshot(identity)
    const queries: string[] = []
    source.knex.on('query', q => queries.push(q.sql))
    await expect(view.readPage('certificateFields', undefined, { maxBytes: 16777216 })).rejects.toThrow('cursor')
    await expect(view.closed).rejects.toThrow('cursor')
    expect(queries.some(sql => sql.includes('`certificate_fields`.*'))).toBe(false)
  }
)

test('empty tables, maximum limits and caller cancellation preserve cleanup semantics', async () => {
  const { source } = await fixture()
  const controller = new AbortController()
  const view = await source.openWalletReadSnapshot(identity, { signal: controller.signal })
  expect(await view.readPage('txLabels', undefined, { maxRows: 1000, maxBytes: 16777216 })).toEqual({
    rows: [],
    payloadBytes: 0,
    done: true,
    cursor: undefined
  })
  controller.abort()
  await expect(view.readPage('txLabels')).rejects.toThrow('cancelled')
  await view.closed
  const fresh = await source.openWalletReadSnapshot(identity)
  await fresh.close()
})

test('concurrent reads refuse instead of queueing and expiry invalidates cursors', async () => {
  const { source, userId } = await fixture()
  await labels(source, userId, 3)
  const view = await source.openWalletReadSnapshot(identity, { lifetimeMs: 10000 })
  const reading = view.readPage('txLabels', undefined, { maxRows: 1 })
  await expect(view.readPage('txLabels')).rejects.toThrow('read in flight')
  const first = await reading
  jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt)
  await expect(view.readPage('txLabels', first.cursor)).rejects.toThrow('expired')
  await view.closed
})

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true]
])(
  'SQL keys support forward seeks without OFFSET or counts (profileIndexes=%s, relationIndexes=%s)',
  async (profileIndexes, relationIndexes) => {
    const { source, userId, otherId } = await fixture()
    if (!profileIndexes) {
      await removeSnapshotProfileIndexes(source.knex)
      await source.knex('knex_migrations').where('name', SNAPSHOT_PROFILE_INDEX_MIGRATION).delete()
    }
    if (!relationIndexes) {
      await removeSnapshotRelationIndexes(source.knex)
      await source.knex('knex_migrations').where('name', SNAPSHOT_RELATION_INDEX_MIGRATION).delete()
    }
    await seedClosure(source, userId, otherId)
    const view = await source.openWalletReadSnapshot(identity)
    const requests: Array<{ sql: string; bindings: Knex.RawBinding[] }> = []
    const collect = (q: { sql: string; bindings: Knex.RawBinding[] }) => {
      if (q.sql.startsWith('select')) requests.push(q)
    }
    source.knex.on('query', collect)
    for (const table of ['txLabels', 'txLabelMaps', 'certificateFields'] as const) {
      const first = await view.readPage(table, undefined, { maxRows: 1 })
      await view.readPage(table, first.cursor, { maxRows: 1 })
    }
    source.knex.removeListener('query', collect)
    await view.close()
    const subsequent = requests.filter(q => q.sql.includes(' > '))
    expect(subsequent).toHaveLength(6)
    expect(subsequent.filter(query => query.sql.includes('snapshot_profile_keys'))).toHaveLength(profileIndexes ? 2 : 0)
    expect(subsequent.filter(query => query.sql.includes('snapshot_relation_keys'))).toHaveLength(
      relationIndexes ? 2 : 0
    )
    for (const query of subsequent) {
      expect(query.sql).not.toMatch(/offset|count\(/i)
      const plan = await source.knex.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
      const details = plan.map((row: { detail: string }) => row.detail).join('\n')
      if (query.sql.includes('snapshot_profile_keys')) {
        expect(details).toMatch(
          /SEARCH snapshot_profile_keys USING COVERING INDEX .*\(snapshotTableId=\? AND snapshotUserId=\? AND snapshotRowId>\?(?: AND snapshotRowId<\?)?\)/
        )
        expect(details).toMatch(/SEARCH tx_labels USING INTEGER PRIMARY KEY \(rowid=\?\)/)
        expect(details).not.toMatch(/SCAN |TEMP B-TREE/)
      } else if (query.sql.includes('snapshot_relation_keys')) {
        expect(details).toMatch(
          /SEARCH snapshot_relation_keys USING COVERING INDEX .*snapshotTableId=\? AND snapshotUserId=\? AND \(snapshotLeftId,snapshotRightId\)>\(\?,\?\)/
        )
        expect(details).not.toMatch(/SCAN |TEMP B-TREE/)
      } else {
        expect(details).toMatch(/SEARCH (tx_labels|tx_labels_map|certificate_fields) USING .*\(.*>\(?\?/)
      }
    }
  }
)

test('an owned certificate with a foreign-user field rejects without returning that field', async () => {
  const { source, userId, otherId } = await fixture()
  await seedClosure(source, userId, otherId)
  await source.knex('certificate_fields').where({ certificateId: 1, fieldName: 'a' }).update({ userId: otherId })
  const view = await source.openWalletReadSnapshot(identity)
  await expect(view.readPage('certificateFields')).rejects.toThrow('does not belong')
  await expect(view.closed).rejects.toThrow('does not belong')
})

test.each(['txLabelMaps', 'outputTagMaps'] as const)(
  'a foreign label/tag linked to an owned parent also rejects: %s',
  async table => {
    const { source, userId, otherId } = await fixture()
    await seedClosure(source, userId, otherId)
    if (table === 'txLabelMaps')
      await source.knex('tx_labels_map').insert({ ...timestamp, txLabelId: 2, transactionId: 1 })
    else await source.knex('output_tags_map').insert({ ...timestamp, outputTagId: 2, outputId: 1 })
    const view = await source.openWalletReadSnapshot(identity)
    await expect(view.readPage(table)).rejects.toThrow('does not belong')
    await expect(view.closed).rejects.toThrow('does not belong')
  }
)

test('a page query failure is observed through read and cleanup before the provider can open a fresh view', async () => {
  const { source, userId } = await fixture()
  await labels(source, userId, 1)
  const failure = new Error('Synthetic page query failure')
  const rejectPage = (query: { sql: string }): void => {
    if (query.sql.includes('__snapshotBytes')) throw failure
  }
  source.knex.on('query', rejectPage)
  const view = await source.openWalletReadSnapshot(identity)
  await expect(view.readPage('txLabels')).rejects.toBe(failure)
  await expect(view.closed).rejects.toBe(failure)
  expect(view.isOpen).toBe(false)
  source.knex.removeListener('query', rejectPage)
  const fresh = await source.openWalletReadSnapshot(identity)
  expect((await fresh.readPage('txLabels')).rows).toHaveLength(1)
  await fresh.close()
})
