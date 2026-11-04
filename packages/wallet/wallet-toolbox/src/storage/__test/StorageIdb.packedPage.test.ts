import { randomUUID } from 'node:crypto'
import { deleteDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type { TableTransaction } from '../schema/tables'

jest.setTimeout(30000)
const identity = '02' + '11'.repeat(32),
  otherIdentity = '03' + '22'.repeat(32)
const timestamps = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
function transaction(id: number, userId = 1, changes: Partial<TableTransaction> = {}): TableTransaction {
  return {
    ...timestamps,
    transactionId: id,
    userId,
    txid: id.toString(16).padStart(64, '0'),
    reference: `packed-${id}`,
    status: 'completed',
    isOutgoing: true,
    satoshis: 0,
    description: 'Packed page fixture',
    rawTx: [1, 2, 3],
    ...changes
  }
}
let storage: StorageIdb
beforeEach(async () => {
  storage = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
  storage.dbName = `packed-page-${randomUUID()}`
  await storage.migrate('Packed page fixture', 'packed-store')
  const seed = storage.db!.transaction('users', 'readwrite')
  await seed.store.put({ ...timestamps, userId: 1, identityKey: identity, activeStorage: 'packed-store' })
  await seed.store.put({ ...timestamps, userId: 2, identityKey: otherIdentity, activeStorage: 'other-store' })
  await seed.done
})
afterEach(async () => {
  await storage.destroy()
  await deleteDB(storage.dbName)
})

test('native keysets return packed binary and tombstones without calling array-expanding find methods', async () => {
  const seed = storage.db!.transaction(['transactions', 'output_tags'], 'readwrite')
  for (const id of [1, 3, 8]) await seed.objectStore('transactions').put(transaction(id))
  await seed.objectStore('transactions').put(transaction(2, 2))
  await seed
    .objectStore('output_tags')
    .put({ ...timestamps, outputTagId: 1, userId: 1, tag: 'deleted', isDeleted: true })
  await seed.done
  const expanded = jest.spyOn(storage, 'validateEntity')
  const first = await storage.readPackedStoragePage(identity, 'transactions', undefined, { maximumRows: 2 })
  expect(first).toMatchObject({ version: 1, consistency: 'transaction', examined: 2, complete: false })
  expect(first.rows.map(row => row.transactionId)).toEqual([1, 3])
  expect(first.rows[0].rawTx).toBeInstanceOf(Uint8Array)
  expect(first.rows[0].rawTx).toEqual(new Uint8Array([1, 2, 3]))
  const next = await storage.readPackedStoragePage(identity, 'transactions', first.cursor)
  expect(next.rows.map(row => row.transactionId)).toEqual([8])
  expect(next.complete).toBe(true)
  expect((await storage.readPackedStoragePage(identity, 'outputTags')).rows[0].isDeleted).toBe(true)
  expect(expanded).not.toHaveBeenCalled()
  expanded.mockRestore()
  // New packed callers do not change the legacy declaration or persisted row.
  expect((await storage.findTransactions({ partial: { transactionId: 1 } }))[0].rawTx).toEqual([1, 2, 3])
  expect((await storage.db!.get('transactions', 1))!.rawTx).toEqual([1, 2, 3])
})

test('compound relation cursors preserve exact keys and refuse a relation spanning two profiles', async () => {
  const seed = storage.db!.transaction(['transactions', 'tx_labels', 'tx_labels_map'], 'readwrite')
  await seed.objectStore('transactions').put(transaction(1))
  await seed.objectStore('transactions').put(transaction(2))
  await seed.objectStore('tx_labels').put({ ...timestamps, txLabelId: 1, userId: 1, label: 'own', isDeleted: false })
  await seed.objectStore('tx_labels').put({ ...timestamps, txLabelId: 2, userId: 2, label: 'other', isDeleted: false })
  for (const id of [1, 2])
    await seed.objectStore('tx_labels_map').put({ ...timestamps, txLabelId: 1, transactionId: id, isDeleted: false })
  await seed.done
  const first = await storage.readPackedStoragePage(identity, 'txLabelMaps', undefined, { maximumRows: 1 })
  expect(first.cursor?.after).toEqual([1, 1])
  expect(
    (await storage.readPackedStoragePage(identity, 'txLabelMaps', first.cursor)).rows.map(row => [
      row.txLabelId,
      row.transactionId
    ])
  ).toEqual([[1, 2]])
  await storage.db!.put('tx_labels_map', { ...timestamps, txLabelId: 2, transactionId: 1, isDeleted: false })
  await expect(storage.readPackedStoragePage(identity, 'txLabelMaps')).rejects.toThrow('current profile or schema')
})

test('global proof pages include request-only references and preserve unrelated-row progress', async () => {
  const seed = storage.db!.transaction(['transactions', 'proven_txs', 'proven_tx_reqs'], 'readwrite')
  await seed.objectStore('transactions').put(transaction(10))
  await seed.objectStore('transactions').put(transaction(20, 2))
  for (const id of [1, 2])
    await seed.objectStore('proven_txs').put({
      ...timestamps,
      provenTxId: id,
      txid: id.toString(16).padStart(64, '0'),
      height: 1,
      index: 0,
      blockHash: 'aa'.repeat(32),
      merkleRoot: 'bb'.repeat(32),
      merklePath: [4],
      rawTx: [5, 6]
    })
  for (const [id, txid] of [
    [1, 20],
    [2, 10]
  ])
    await seed.objectStore('proven_tx_reqs').put({
      ...timestamps,
      provenTxReqId: id,
      provenTxId: id,
      txid: txid.toString(16).padStart(64, '0'),
      status: 'completed',
      attempts: 0,
      notified: true,
      history: '{}',
      notify: '{}',
      rawTx: [7]
    })
  await seed.done
  const foreign = await storage.readPackedStoragePage(identity, 'provenTxs', undefined, { maximumExamined: 1 })
  expect(foreign.rows).toEqual([])
  expect(foreign).toMatchObject({ examined: 1, complete: false, cursor: { after: 1 } })
  const own = await storage.readPackedStoragePage(identity, 'provenTxs', foreign.cursor)
  expect(own.rows.map(row => row.provenTxId)).toEqual([2])
  expect(own.rows[0].rawTx).toEqual(new Uint8Array([5, 6]))
  expect((await storage.readPackedStoragePage(identity, 'provenTxReqs')).rows.map(row => row.provenTxReqId)).toEqual([
    2
  ])
})

test('cursor metadata cannot authorize another profile, storage or table', async () => {
  await storage.db!.put('transactions', transaction(1))
  const first = await storage.readPackedStoragePage(identity, 'transactions')
  expect(first.cursor).toBeDefined()
  await expect(storage.readPackedStoragePage(otherIdentity, 'transactions', first.cursor)).rejects.toThrow(
    'current profile or schema'
  )
  await expect(storage.readPackedStoragePage(identity, 'outputTags', first.cursor)).rejects.toThrow(
    'current profile or schema'
  )
  await expect(
    storage.readPackedStoragePage(identity, 'transactions', { ...first.cursor!, storageIdentityKey: 'different' })
  ).rejects.toThrow('current profile or schema')
  await expect(storage.readPackedStoragePage('unknown', 'transactions')).rejects.toThrow()
})

test('byte refusal and cancellation leave the native database usable and do not skip the oversized row', async () => {
  await storage.db!.put('transactions', transaction(1, 1, { rawTx: Array.from({ length: 1024 }, () => 81) }))
  await expect(
    storage.readPackedStoragePage(identity, 'transactions', undefined, { maximumBytes: 1000 })
  ).rejects.toThrow('row exceeds')
  const complete = await storage.readPackedStoragePage(identity, 'transactions')
  expect(complete.rows).toHaveLength(1)
  expect(complete.rows[0].transactionId).toBe(1)
  expect(complete.rows[0].rawTx).toHaveLength(1024)
  const controller = new AbortController(),
    reason = new Error('Packed read cancelled')
  controller.abort(reason)
  await expect(
    storage.readPackedStoragePage(identity, 'transactions', undefined, { signal: controller.signal })
  ).rejects.toBe(reason)
  await storage.db!.put('transactions', transaction(2))
  expect((await storage.readPackedStoragePage(identity, 'transactions')).rows.map(row => row.transactionId)).toEqual([
    1, 2
  ])
})

test('the legacy no-send reclaim binary is packed with all transaction payloads without changing persisted or legacy values', async () => {
  const reclaim = [0, 127, 255],
    row = transaction(1, 1, {
      inputBEEF: [19, 23],
      noSendExpiryReclaimRawTx: reclaim
    })
  await storage.db!.put('transactions', row)
  const page = await storage.readPackedStoragePage(identity, 'transactions'),
    packed = page.rows[0]
  expect(packed.rawTx).toEqual(new Uint8Array([1, 2, 3]))
  expect(packed.inputBEEF).toEqual(new Uint8Array([19, 23]))
  expect(packed.noSendExpiryReclaimRawTx).toEqual(new Uint8Array(reclaim))
  packed.noSendExpiryReclaimRawTx!.fill(44)
  expect((await storage.db!.get('transactions', 1))!.noSendExpiryReclaimRawTx).toEqual(reclaim)
  expect((await storage.findTransactions({ partial: { transactionId: 1 } }))[0].noSendExpiryReclaimRawTx).toEqual(
    reclaim
  )
})
