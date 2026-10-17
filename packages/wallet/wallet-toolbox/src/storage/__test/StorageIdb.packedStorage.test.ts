import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { deleteDB, openDB } from 'idb'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type { TableTransaction, TableSyncState } from '../schema/tables'
import type { PackedIdbSchema, PackedIdbTransaction } from '../idbPackedFields'
import { packedIdbIsUint8Array } from '../idbPackedFields'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { openBrc38IdbSource } from '../portable/Brc38IdbSource'
import { createBrc38Stream, exportBRC38, parseBRC38Json } from '../portable'
import { encodeBrc38StreamedRow } from '../portable/Brc38StreamedRow'
import { PackedIdbJsonIndex } from '../idbPackedJsonIndex'
import { getPackedIdbConnection } from '../idbPackedConnection'
import type { PackedIdbReadSnapshot } from '../idbPackedSnapshot'

const identity = '02' + '11'.repeat(32),
  otherIdentity = '03' + '22'.repeat(32)
const timestamps = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
let storage: StorageIdb
function row(id: number, changes: Partial<TableTransaction> = {}): TableTransaction {
  return {
    ...timestamps,
    transactionId: id,
    userId: 1,
    txid: id.toString(16).padStart(64, '0'),
    reference: `packed-${id}`,
    status: 'completed',
    isOutgoing: true,
    satoshis: 0,
    description: 'Packed store fixture',
    rawTx: [1, 2, 3],
    ...changes
  }
}
beforeEach(async () => {
  storage = new StorageIdb({ ...StorageProvider.createStorageBaseOptions('main'), packed: {} })
  storage.dbName = `packed-storage-${randomUUID()}`
  await storage.migrate('Packed store fixture', 'packed-store')
  await storage.db!.put('users', { ...timestamps, userId: 1, identityKey: identity, activeStorage: 'packed-store' })
  await storage.db!.put('users', { ...timestamps, userId: 2, identityKey: otherIdentity, activeStorage: 'other-store' })
})
afterEach(async () => {
  await storage.destroy()
  await deleteDB(storage.dbName)
})

test('large structured history exports through actual indexed spans without the ordinary whole-row allocation', async () => {
  const history = { notes: [{ what: 'A'.repeat(90000), optional: null }], original: [1, 2, 3] }
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: JSON.stringify(history),
    notify: '{}',
    rawTx: [6]
  })
  const options = {
    maximumPageRows: 8,
    maximumPageBytes: 65536,
    maximumRowAllocationBytes: 65536,
    maximumCertificateGroupBytes: 65536,
    maximumMetadataAllocationBytes: 65536
  }
  const ordinary = await openBrc38IdbSource(storage, identity, options)
  try {
    await expect(ordinary.rows('provenTxReqs')[Symbol.asyncIterator]().next()).rejects.toThrow('allocation')
  } finally {
    await ordinary.release()
  }
  const packed = await openBrc38IdbSource(storage, identity, {
    ...options,
    streamedStructured: { maximumStructuredBytes: 1048576 }
  })
  try {
    const rows = packed.streamedRows!('provenTxReqs')
    for await (const source of rows) {
      expect(source.fields.history).toBeUndefined()
      expect(source.structured!.history.encoding).toBe('utf16le')
      const chunks: Uint8Array[] = []
      for await (const chunk of encodeBrc38StreamedRow('provenTxReqs', source, {
        maximumMetadataAllocationBytes: 65536,
        maximumBinaryBytes: 1048576,
        maximumStructuredBytes: 1048576,
        maximumRowBytes: 1048576
      })) {
        expect(chunk.length).toBeLessThanOrEqual(65536)
        chunks.push(chunk)
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { history: typeof history; rawTx: string }
      expect(parsed.history).toEqual({ notes: [{ what: history.notes[0].what }], original: [1, 2, 3] })
      expect(parsed.rawTx).toBe(Buffer.from([6]).toString('base64'))
    }
  } finally {
    await packed.release()
  }
  const inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
  try {
    expect(await inspection.count('_wallet_packed_json_stages')).toBe(0)
    expect(await inspection.count('_wallet_packed_json_members')).toBe(0)
  } finally {
    inspection.close()
  }
})

test('sealed unattached stage reads are owned, bounded, hash checked and revoked by close', async () => {
  const bytes = new Uint8Array(70000).map((_, index) => index % 251),
    stage = await storage.beginPackedStorageField({
      kind: 'typed',
      bytes: bytes.length,
      sha256: new SHA256().update(bytes).digestHex()
    })
  try {
    await stage.append(0, bytes.slice(0, 65536))
    await stage.append(65536, bytes.slice(65536))
    await expect(stage.read(0, 4)).rejects.toThrow()
    await stage.finish()
    expect(await stage.read(65530, 20)).toEqual(bytes.slice(65530, 65550))
    await expect(stage.read(0, 65537)).rejects.toThrow()
    const copied = Object.assign(Object.create(Object.getPrototypeOf(stage)), stage) as PackedIdbStagedField
    await expect(copied.read(0, 4)).rejects.toThrow()
    const tx = getPackedIdbConnection(storage.db!)!.rawTransaction([], 'readwrite'),
      chunks = tx.objectStore('_wallet_packed_chunks'),
      key: [string, number] = [stage.descriptor.content, 0],
      stored = (await chunks.get(key))!
    const corrupt = stored.data.slice()
    corrupt[0] ^= 1
    await chunks.put({ ...stored, data: corrupt })
    await tx.done
    await expect(stage.read(0, 4)).rejects.toThrow()
  } finally {
    await stage.close()
  }
  await expect(stage.read(0, 4)).rejects.toThrow()
})
test('byte branding accepts genuine foreign Uint8Array while refusing prototype and tag copies', () => {
  expect(packedIdbIsUint8Array(runInNewContext('new Uint8Array([1,2,3])'))).toBe(true)
  expect(packedIdbIsUint8Array(Buffer.from([1]))).toBe(true)
  for (const value of [
    Object.create(Uint8Array.prototype),
    new Proxy(new Uint8Array(1), {}),
    { [Symbol.toStringTag]: 'Uint8Array' },
    new Uint16Array(1),
    new DataView(new ArrayBuffer(1))
  ])
    expect(packedIdbIsUint8Array(value)).toBe(false)
})

test('JSON index refuses a copied snapshot and a primary revision changed after opening', async () => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: JSON.stringify({ original: 'A'.repeat(5000) }),
    notify: '{}'
  })
  const view = (await storage.openWalletReadSnapshot(identity)) as PackedIdbReadSnapshot
  const owner = getPackedIdbConnection(storage.db!)!
  try {
    const page = await view.readFieldMetadataPage('provenTxReqs'),
      field = page.rows[0].extents.history
    await expect(PackedIdbJsonIndex.open(owner, { ...view }, field)).rejects.toThrow()
    const index = await PackedIdbJsonIndex.open(owner, view, field)
    try {
      await storage.db!.put('users', { ...timestamps, userId: 1, identityKey: identity, activeStorage: 'away' })
      await storage.db!.put('users', { ...timestamps, userId: 1, identityKey: identity, activeStorage: 'packed-store' })
      await expect(index.put(0, { key: 'original', keyOffset: 2, start: 24, end: field.bytes - 2 })).rejects.toThrow()
    } finally {
      await index.close()
    }
  } finally {
    await view.close()
  }
})

test.each([
  { maximumMembers: 1, maximumBytes: 4096 },
  { maximumMembers: 2, maximumBytes: 512 + 258 }
])('JSON index enforces its original independent limits and rolls back a refused member (%j)', async limits => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: JSON.stringify({ original: 'A'.repeat(5000) }),
    notify: '{}'
  })
  const view = (await storage.openWalletReadSnapshot(identity)) as PackedIdbReadSnapshot,
    owner = getPackedIdbConnection(storage.db!)!,
    inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
  let index: PackedIdbJsonIndex | undefined
  try {
    const field = (await view.readFieldMetadataPage('provenTxReqs')).rows[0].extents.history,
      selected = { ...limits },
      pending = PackedIdbJsonIndex.open(owner, view, field, selected)
    selected.maximumMembers = 100
    selected.maximumBytes = 100000
    index = await pending
    const first = { key: 'a', keyOffset: 2, start: 20, end: 24 }
    await index.put(0, first)
    // JSON duplicate keys replace their earlier span and consume no new member.
    await index.put(0, { ...first, start: 26, end: 30 })
    await expect(index.put(0, { ...first, key: 'b' })).rejects.toThrow('original member/byte allowance')
    const stages = await inspection.getAll('_wallet_packed_json_stages')
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatchObject({ ...limits, members: 1, bytes: 258, state: 'pending' })
    expect(await inspection.count('_wallet_packed_json_members')).toBe(1)
    await index.seal()
    expect(await index.lookup(0, 'a')).toEqual({ ...first, start: 26, end: 30, firstKeyOffset: 2 })
    expect(await index.lookup(0, 'missing')).toBeUndefined()
    const actual = []
    for await (const item of index.entries(0)) actual.push(item)
    expect(actual).toEqual([{ ...first, start: 26, end: 30 }])
  } finally {
    try {
      await index?.close()
    } finally {
      await view.close()
      inspection.close()
    }
  }
})

test('packed sort spans have an explicit data bound and retain first original insertion across replacements', async () => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: JSON.stringify({ original: 'A'.repeat(5000) }),
    notify: '{}'
  })
  const view = (await storage.openWalletReadSnapshot(identity)) as PackedIdbReadSnapshot,
    owner = getPackedIdbConnection(storage.db!)!
  let index: PackedIdbJsonIndex | undefined
  try {
    const field = (await view.readFieldMetadataPage('provenTxReqs')).rows[0].extents.history,
      spanBytes = field.bytes + 4096
    index = await PackedIdbJsonIndex.open(owner, view, field, {
      maximumBytes: 4096,
      maximumMembers: 1,
      maximumSourceSpanBytes: spanBytes
    })
    await index.put(0, { key: 'derived', keyOffset: 40, start: field.bytes + 2, end: field.bytes + 20 })
    await index.put(0, { key: 'derived', keyOffset: 20, start: field.bytes + 24, end: field.bytes + 40 })
    await index.put(0, { key: 'derived', keyOffset: 60, start: field.bytes + 44, end: field.bytes + 60 })
    await expect(
      index.put(0, { key: 'derived', keyOffset: 80, start: spanBytes - 1, end: spanBytes + 1 })
    ).rejects.toThrow()
    await index.seal()
    expect(await index.lookup(0, 'derived')).toEqual({
      key: 'derived',
      keyOffset: 60,
      firstKeyOffset: 20,
      start: field.bytes + 44,
      end: field.bytes + 60
    })
    // Expanded sort coordinates do not alter the genuine retained field.
    await expect(
      view.readFieldExtent(
        'provenTxReqs',
        { version: 1, snapshotId: view.snapshotId, table: 'provenTxReqs', after: [1] },
        'history',
        field.bytes + 2,
        2,
        field
      )
    ).rejects.toThrow()
  } finally {
    try {
      await index?.close()
    } finally {
      await view.close()
    }
  }
})

test('JSON index close physically drains more than one slice without retiring another expired index', async () => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: JSON.stringify({ original: 'A'.repeat(5000) }),
    notify: '{}'
  })
  const view = (await storage.openWalletReadSnapshot(identity)) as PackedIdbReadSnapshot,
    owner = getPackedIdbConnection(storage.db!)!,
    inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
  let selected: PackedIdbJsonIndex | undefined, other: PackedIdbJsonIndex | undefined
  try {
    const field = (await view.readFieldMetadataPage('provenTxReqs')).rows[0].extents.history
    other = await PackedIdbJsonIndex.open(owner, view, field)
    await other.put(0, { key: 'unrelated', keyOffset: 2, start: 20, end: 24 })
    const earlier = (await inspection.getAll('_wallet_packed_json_stages'))[0]
    await inspection.put('_wallet_packed_json_stages', { ...earlier, state: 'retiring', expiresAt: 0 })
    selected = await PackedIdbJsonIndex.open(owner, view, field, { maximumMembers: 129, maximumBytes: 65536 })
    for (let i = 0; i < 129; i++)
      await selected.put(0, { key: `member-${i.toString().padStart(3, '0')}`, keyOffset: 2, start: 20, end: 24 })
    await selected.seal()
    expect(await inspection.count('_wallet_packed_json_members')).toBe(130)
    await selected.close()
    await selected.close()
    expect(await inspection.count('_wallet_packed_json_members')).toBe(1)
    expect(await inspection.getAll('_wallet_packed_json_stages')).toEqual([
      { ...earlier, state: 'retiring', expiresAt: 0 }
    ])
    await expect(selected.entries(0).next()).rejects.toThrow()
  } finally {
    try {
      await selected?.close()
      await other?.close()
    } finally {
      await view.close()
      inspection.close()
    }
  }
  const final = await openDB<PackedIdbSchema>(storage.dbName, 7)
  try {
    expect(await final.count('_wallet_packed_json_stages')).toBe(0)
    expect(await final.count('_wallet_packed_json_members')).toBe(0)
  } finally {
    final.close()
  }
})

test('the explicit layout stores bounded metadata/chunks and preserves the original DTO including no-send bytes', async () => {
  await storage.db!.put(
    'transactions',
    row(1, { rawTx: Array.from({ length: 70000 }, (_, i) => i % 256), noSendExpiryReclaimRawTx: [0, 127, 255] })
  )
  const inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
  try {
    const actual = await inspection.get('transactions', 1)
    expect(actual?.rawTx).toBeUndefined()
    expect(actual?.noSendExpiryReclaimRawTx).toBeUndefined()
    const metadata = actual?.__walletPackedV1 as Record<string, { content: string; bytes: number }>
    expect(metadata.rawTx.bytes).toBe(70000)
    expect((await inspection.get('_wallet_packed_chunks', [metadata.rawTx.content, 0]))!.data).toHaveLength(65536)
    expect((await inspection.get('_wallet_packed_chunks', [metadata.rawTx.content, 1]))!.data).toHaveLength(4464)
  } finally {
    inspection.close()
  }
  const legacy = await storage.db!.get('transactions', 1)
  expect(Array.isArray(legacy!.rawTx)).toBe(true)
  expect(legacy!.rawTx).toHaveLength(70000)
  expect(legacy!.noSendExpiryReclaimRawTx).toEqual([0, 127, 255])
  const packed = await storage.readPackedStoragePage(identity, 'transactions')
  expect(packed.rows[0].rawTx).toBeInstanceOf(Uint8Array)
  expect(packed.rows[0].noSendExpiryReclaimRawTx).toEqual(new Uint8Array([0, 127, 255]))
})

test('writers advance between pages while the original revision retains changed and physically deleted rows', async () => {
  for (const id of [1, 2, 3]) await storage.db!.put('transactions', row(id))
  const snapshot = await storage.openWalletReadSnapshot(identity)
  try {
    const first = await snapshot.readPage('transactions', undefined, { maxRows: 1 })
    expect(first.rows[0].transactionId).toBe(1)
    // Completion of these foreground transactions while the handle remains open
    // establishes that it did not retain an overlapping readonly transaction.
    await storage.db!.put('transactions', row(2, { description: 'Changed after ceiling', rawTx: [8, 9] }))
    const deletion = storage.db!.transaction('transactions', 'readwrite')
    await (await deletion.store.openCursor(3))!.delete()
    await deletion.done
    await storage.collectPackedStorage()
    const rest = await snapshot.readPage('transactions', first.cursor)
    expect(rest.rows.map(value => value.transactionId)).toEqual([2, 3])
    expect(rest.rows[0].description).toBe('Packed store fixture')
    expect(rest.rows[0].rawTx).toEqual(new Uint8Array([1, 2, 3]))
    expect((await storage.db!.get('transactions', 2))!.rawTx).toEqual([8, 9])
    expect(await storage.db!.get('transactions', 3)).toBeUndefined()
  } finally {
    await snapshot.close()
  }
  expect((await storage.collectPackedStorage()).versions).toBeGreaterThan(0)
})

test('historic global closure retains the original transaction/request references after request deletion', async () => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_txs', {
    ...timestamps,
    provenTxId: 7,
    txid: '77'.repeat(32),
    height: 1,
    index: 0,
    blockHash: 'aa'.repeat(32),
    merkleRoot: 'bb'.repeat(32),
    merklePath: [4],
    rawTx: [5]
  })
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 8,
    provenTxId: 7,
    txid: row(1).txid!,
    status: 'completed',
    attempts: 0,
    notified: true,
    history: '{}',
    notify: '{}',
    rawTx: [6]
  })
  const snapshot = await storage.openWalletReadSnapshot(identity)
  try {
    await storage.db!.delete('proven_tx_reqs', 8)
    expect((await snapshot.readPage('provenTxs')).rows.map(value => value.provenTxId)).toEqual([7])
    expect((await snapshot.readPage('provenTxReqs')).rows.map(value => value.provenTxReqId)).toEqual([8])
  } finally {
    await snapshot.close()
  }
  expect((await storage.readPackedStoragePage(identity, 'provenTxs')).rows).toEqual([])
})

test('a streamed field is detached, retriable and independently sealed before atomic row attachment', async () => {
  const data = Uint8Array.from({ length: 1048576 }, (_, i) => i % 251),
    sha256 = new SHA256().update(data).digestHex()
  const stage = await storage.beginPackedStorageField({ kind: 'array', bytes: data.length, sha256 })
  try {
    const input = data.slice(0, 65536),
      first = stage.append(0, input)
    input.fill(255)
    await first
    await stage.append(0, data.slice(0, 65536))
    for (let offset = 65536; offset < data.length; offset += 65536)
      await stage.append(offset, data.slice(offset, offset + 65536))
    expect((await stage.finish()).sha256).toBe(sha256)
    const { rawTx: _rawTx, ...metadata } = row(1)
    await storage.writeStagedStorageRow('transactions', metadata, { rawTx: stage })
    const snapshot = await storage.openWalletReadSnapshot(identity)
    try {
      const page = await snapshot.readFieldMetadataPage('transactions', undefined, { maxBytes: 4096 })
      expect(page.rows[0].fields.rawTx).toBeUndefined()
      expect(page.rows[0].extents.rawTx.bytes).toBe(data.length)
      const extent = await snapshot.readFieldExtent(
        'transactions',
        page.rows[0].cursor,
        'rawTx',
        65520,
        64,
        page.rows[0].extents.rawTx
      )
      expect(extent).toEqual(data.slice(65520, 65584))
      await expect(snapshot.readPage('transactions', undefined, { maxBytes: 4096 })).rejects.toThrow('budget')
      await expect(
        snapshot.readFieldExtent(
          'transactions',
          { ...page.rows[0].cursor, snapshotId: 'copied-label' },
          'rawTx',
          0,
          1,
          page.rows[0].extents.rawTx
        )
      ).rejects.toThrow()
    } finally {
      await snapshot.close()
    }
  } finally {
    await stage.close()
  }
})

test('large UTF-16 histories preserve every code unit including lone surrogates', async () => {
  const history = 'x\ud800y\udc00'.repeat(5000)
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: '11'.repeat(32),
    status: 'completed',
    attempts: 0,
    notified: false,
    history,
    notify: '{}'
  })
  expect((await storage.db!.get('proven_tx_reqs', 1))!.history).toBe(history)
})

test('a genuine operational writer commits staged content, MVCC and its checkpoint atomically', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, index) => index % 251),
    stage = await storage.beginPackedStorageField({
      kind: 'typed',
      bytes: bytes.length,
      sha256: new SHA256().update(bytes).digestHex()
    }),
    { rawTx: _rawTx, ...metadata } = row(1),
    checkpoint: TableSyncState = {
      ...timestamps,
      syncStateId: 1,
      userId: 1,
      storageIdentityKey: 'independent-source',
      storageName: 'Independent source',
      status: 'updated',
      init: true,
      refNum: 'page-one',
      syncMap: '{}'
    },
    owner = getPackedIdbConnection(storage.db!)!
  const inspection = await openDB<PackedIdbSchema>(storage.dbName, 7)
  try {
    await stage.append(0, bytes.slice(0, 65536))
    await stage.append(65536, bytes.slice(65536))
    await stage.finish()
    const initialClock = await inspection.get('_wallet_packed_clock', 'clock'),
      originalContent = stage.descriptor.content
    const failed = storage.db!.transaction(['transactions', 'sync_states'], 'readwrite')
    void failed.done.catch(() => undefined)
    try {
      await storage.writeStagedStorageRow('transactions', metadata, { rawTx: stage }, 'add', failed)
      await failed.objectStore('sync_states').add(checkpoint)
      failed.abort()
    } finally {
      await expect(failed.done).rejects.toThrow()
    }
    expect(await storage.db!.get('transactions', 1)).toBeUndefined()
    expect(await storage.db!.get('sync_states', 1)).toBeUndefined()
    expect(await inspection.get('_wallet_packed_clock', 'clock')).toEqual(initialClock)
    const unchanged = await inspection.get('_wallet_packed_contents', originalContent)
    expect(unchanged!.refs).toBe(0)
    expect(unchanged!.expiresAt).toBeDefined()
    const committed = storage.db!.transaction(['transactions', 'sync_states'], 'readwrite')
    await storage.writeStagedStorageRow('transactions', metadata, { rawTx: stage }, 'add', committed)
    await committed.objectStore('sync_states').add(checkpoint)
    await committed.done
    expect((await storage.db!.get('transactions', 1))!.rawTx).toEqual(bytes)
    expect((await storage.db!.get('sync_states', 1))!.refNum).toBe('page-one')
    expect((await inspection.get('_wallet_packed_contents', originalContent))!.refs).toBe(1)
    // Neither copied facades nor a different genuine owner's transaction can
    // move this stage into an unowned writer.
    const readOnly = storage.db!.transaction('transactions', 'readonly')
    await expect(
      owner.writeStagedInTransaction(
        readOnly as unknown as PackedIdbTransaction,
        'transactions',
        metadata,
        { rawTx: stage },
        true
      )
    ).rejects.toThrow()
    await readOnly.done
    await expect(
      owner.writeStagedInTransaction(
        { ...committed } as unknown as PackedIdbTransaction,
        'transactions',
        metadata,
        { rawTx: stage },
        true
      )
    ).rejects.toThrow()
  } finally {
    inspection.close()
    await stage.close()
    bytes.fill(0)
  }
})

test('a current-row revision retains actual large fields and shares checkpoint rollback', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, index) => (index * 17) % 251),
    stage = await storage.beginPackedStorageField({
      kind: 'typed',
      bytes: bytes.length,
      sha256: new SHA256().update(bytes).digestHex()
    }),
    inspection = await openDB<PackedIdbSchema>(storage.dbName, 7),
    { rawTx: _rawTx, ...metadata } = row(1)
  try {
    await stage.append(0, bytes.subarray(0, 65536))
    await stage.append(65536, bytes.subarray(65536))
    await stage.finish()
    await storage.writeStagedStorageRow('transactions', metadata, { rawTx: stage }, 'add')
    const content = stage.descriptor.content,
      before = await inspection.get('_wallet_packed_heads', ['transactions', 1]),
      retained = { revision: before!.revision as number, names: ['rawTx'] },
      initialClock = await inspection.get('_wallet_packed_clock', 'clock')
    const failed = storage.db!.transaction(['transactions', 'sync_states'], 'readwrite')
    void failed.done.catch(() => undefined)
    await storage.writeStagedStorageRow(
      'transactions',
      { ...metadata, description: 'rollback' },
      {},
      'put',
      failed,
      retained
    )
    await failed.objectStore('sync_states').add({
      ...timestamps,
      syncStateId: 1,
      userId: 1,
      storageIdentityKey: 'source',
      storageName: 'Independent',
      status: 'updated',
      init: true,
      syncMap: '{}',
      refNum: 'rollback'
    })
    failed.abort()
    await expect(failed.done).rejects.toThrow()
    expect(await inspection.get('_wallet_packed_clock', 'clock')).toEqual(initialClock)
    expect((await inspection.get('_wallet_packed_contents', content))!.refs).toBe(1)
    expect(await storage.db!.get('sync_states', 1)).toBeUndefined()
    const writer = storage.db!.transaction(['transactions', 'sync_states'], 'readwrite')
    await storage.writeStagedStorageRow(
      'transactions',
      { ...metadata, description: 'retained' },
      {},
      'put',
      writer,
      retained
    )
    await writer.objectStore('sync_states').add({
      ...timestamps,
      syncStateId: 1,
      userId: 1,
      storageIdentityKey: 'source',
      storageName: 'Independent',
      status: 'updated',
      init: true,
      syncMap: '{}',
      refNum: 'committed'
    })
    await writer.done
    expect((await storage.db!.get('transactions', 1))!.rawTx).toEqual(bytes)
    expect((await inspection.get('_wallet_packed_contents', content))!.refs).toBe(2)
    const newHead = await inspection.get('_wallet_packed_heads', ['transactions', 1])
    expect(newHead!.revision).not.toBe(retained.revision)
    await expect(
      storage.writeStagedStorageRow(
        'transactions',
        { ...metadata, description: 'stale' },
        {},
        'put',
        undefined,
        retained
      )
    ).rejects.toThrow()
    expect((await storage.db!.get('transactions', 1))!.description).toBe('retained')
    // Retention cannot insert another row, use copied descriptors, retain a
    // missing field or collide with an inline replacement field.
    await expect(
      storage.writeStagedStorageRow('transactions', { ...metadata, transactionId: 2 }, {}, 'add', undefined, retained)
    ).rejects.toThrow()
    const current = { revision: newHead!.revision as number, names: ['inputBEEF'] }
    await expect(
      storage.writeStagedStorageRow('transactions', metadata, {}, 'put', undefined, current)
    ).rejects.toThrow()
    await expect(
      storage.writeStagedStorageRow('transactions', { ...metadata, rawTx: undefined }, {}, 'put', undefined, {
        revision: current.revision,
        names: ['rawTx']
      })
    ).rejects.toThrow()
  } finally {
    inspection.close()
    await stage.close()
    bytes.fill(0)
  }
})

test('descriptor copies cannot replace an actual stage and primary away-and-back changes fence an existing snapshot', async () => {
  await storage.db!.put('transactions', row(1))
  const stage = await storage.beginPackedStorageField({ kind: 'array', bytes: 0, sha256: new SHA256().digestHex() })
  try {
    await stage.finish()
    const { rawTx: _rawTx, ...metadata } = row(2)
    await expect(
      storage.writeStagedStorageRow('transactions', metadata, {
        rawTx: { descriptor: stage.descriptor } as unknown as PackedIdbStagedField
      })
    ).rejects.toThrow()
    expect(await storage.db!.get('transactions', 2)).toBeUndefined()
  } finally {
    await stage.close()
  }
  const snapshot = await storage.openWalletReadSnapshot(identity)
  try {
    await storage.db!.put('users', { ...timestamps, userId: 1, identityKey: identity, activeStorage: 'away' })
    await storage.db!.put('users', { ...timestamps, userId: 1, identityKey: identity, activeStorage: 'packed-store' })
    await expect(snapshot.readPage('transactions')).rejects.toThrow()
  } finally {
    await snapshot.close()
  }
})

test('reopening uses retained data and current limits; a closed stage cannot revive after owner replacement', async () => {
  await storage.db!.put('transactions', row(1))
  const stage = await storage.beginPackedStorageField({ kind: 'typed', bytes: 0, sha256: new SHA256().digestHex() })
  await stage.finish()
  await storage.destroy()
  await storage.migrate('Ignored existing name', 'packed-store')
  expect((await storage.db!.get('transactions', 1))!.rawTx).toEqual([1, 2, 3])
  const { rawTx: _rawTx, ...metadata } = row(2)
  await expect(storage.writeStagedStorageRow('transactions', metadata, { rawTx: stage })).rejects.toThrow()
  await stage.close()
})

test('the all13 streamed source preserves exact legacy BRC-38 data and no-send spelling', async () => {
  await storage.db!.put('transactions', row(1, { noSendExpiryReclaimRawTx: [0, 127, 255] }))
  const expected = await exportBRC38(storage, identity)
  const source = await openBrc38IdbSource(storage, identity, {
    maximumPageRows: 16,
    maximumPageBytes: 65536,
    maximumRowAllocationBytes: 65536,
    maximumMetadataAllocationBytes: 65536,
    maximumCertificateGroupBytes: 65536,
    streamedBinary: { maximumBinaryBytes: 1048576, maximumExtentBytes: 65536 }
  })
  const stream = await createBrc38Stream(source, {
    exportedAt: expected.exportedAt,
    maximumArchiveBytes: 1048576,
    maximumRowBytes: 65536,
    streamedRows: { maximumMetadataAllocationBytes: 65536, maximumBinaryBytes: 1048576, maximumRowBytes: 1048576 }
  })
  try {
    const chunks: Uint8Array[] = [],
      maximum = 1048576
    let bytes = 0
    for await (const chunk of stream.chunks) {
      bytes += chunk.length
      expect(bytes).toBeLessThanOrEqual(maximum)
      chunks.push(chunk)
    }
    const complete = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      complete.set(chunk, offset)
      offset += chunk.length
    }
    expect(parseBRC38Json(new TextDecoder().decode(complete))).toEqual(expected)
    await stream.validateCompleted()
  } finally {
    await stream.close()
  }
})

// Legacy SQLite archives can place the numeric optional flag in IDB. Compare
// complete documents with the real original getter, not another stream mode.
test.each([false, true, 0, 1])('IDB archives preserve the original request flag %p in both modes', async flag => {
  await storage.db!.put('transactions', row(1))
  await storage.db!.put('proven_tx_reqs', {
    ...timestamps,
    provenTxReqId: 1,
    txid: row(1).txid!,
    status: 'unmined',
    attempts: 0,
    notified: true,
    wasBroadcast: flag as unknown as boolean,
    history: '{"notes":[{"what":"original"}]}',
    notify: '{}',
    rawTx: [6]
  })
  const expected = await exportBRC38(storage, identity)
  expect(expected.tables.provenTxReqs[0].wasBroadcast).toBe(flag)
  for (const packed of [false, true]) {
    const source = await openBrc38IdbSource(storage, identity, {
      maximumPageRows: 1,
      maximumPageBytes: 65536,
      maximumRowAllocationBytes: 65536,
      maximumCertificateGroupBytes: 65536,
      ...(packed
        ? { streamedBinary: { maximumBinaryBytes: 65536 }, streamedStructured: { maximumStructuredBytes: 65536 } }
        : {})
    })
    try {
      const stream = await createBrc38Stream(source, {
        exportedAt: expected.exportedAt,
        maximumArchiveBytes: 1048576,
        maximumRowBytes: 65536,
        maximumMetadataBytes: 65536,
        maximumChunkBytes: 4096,
        ...(packed
          ? {
              streamedRows: {
                maximumBinaryBytes: 65536,
                maximumStructuredBytes: 65536,
                maximumMetadataAllocationBytes: 65536,
                maximumRowBytes: 65536
              }
            }
          : {})
      })
      try {
        const chunks: Uint8Array[] = []
        for await (const chunk of stream.chunks) chunks.push(chunk)
        await stream.validateCompleted()
        expect(parseBRC38Json(Buffer.concat(chunks).toString('utf8'))).toEqual(expected)
      } finally {
        await stream.close()
      }
    } finally {
      await source.release()
    }
  }
  expect((await storage.db!.get('proven_tx_reqs', 1))!.wasBroadcast).toBe(flag)
})
