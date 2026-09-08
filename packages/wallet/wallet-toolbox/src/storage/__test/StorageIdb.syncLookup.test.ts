import { randomUUID } from 'node:crypto'
import { deleteDB, openDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import * as idbHelpers from '../idbHelpers'
import { StorageIdbSchema } from '../schema/StorageIdbSchema'
import { TableProvenTx, TableTransaction } from '../schema/tables'

const identity = '42'.repeat(32)
const targetTxid = 'ab'.repeat(32)
const reclaimTxid = 'cd'.repeat(32)

function transaction(transactionId: number, partial: Partial<TableTransaction> = {}): TableTransaction {
  return {
    transactionId,
    userId: 1,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    reference: `reference-${transactionId}`,
    status: 'completed',
    isOutgoing: true,
    satoshis: 0,
    description: 'Synthetic sync lookup fixture',
    txid: transactionId.toString(16).padStart(64, '0'),
    rawTx: [1, 2, 3],
    ...partial
  }
}

function storage(): StorageIdb {
  const result = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
  result.dbName = `sync-lookup-${randomUUID()}`
  return result
}

describe('IndexedDB sync identity lookups', () => {
  test('transaction, reference and reclaim lookups visit bounded rows as a wallet grows', async () => {
    const writer = storage()
    await writer.migrate('Synthetic sync lookups', identity)
    try {
      const db = writer.db!
      const seed = db.transaction('transactions', 'readwrite')
      for (let id = 1; id <= 1000; id++) await seed.store.put(transaction(id))
      await seed.store.put(transaction(1001, { userId: 2, txid: targetTxid, noSendExpiryReclaimTxid: reclaimTxid }))
      await seed.store.put(transaction(1002, { txid: targetTxid, noSendExpiryReclaimTxid: reclaimTxid }))
      await seed.store.put(transaction(1003, { txid: targetTxid, noSendExpiryReclaimTxid: reclaimTxid }))
      await seed.done

      const visits = jest.spyOn(idbHelpers, 'matchesTransactionPartial')
      try {
        const found = await writer.findTransactions({ partial: { userId: 1, txid: targetTxid }, noRawTx: true })
        expect(found.map(row => row.transactionId)).toEqual([1002, 1003])
        expect(visits.mock.calls.length).toBeLessThanOrEqual(3)
        visits.mockClear()
        expect(await writer.findTransactions({
          partial: { userId: 1, txid: targetTxid, status: 'failed' }, noRawTx: true
        })).toEqual([])
        expect(visits.mock.calls.length).toBeLessThanOrEqual(3)
        visits.mockClear()
        expect((await writer.findTransactions({
          partial: { userId: 1, reference: 'reference-1002' }, noRawTx: true
        })).map(row => row.transactionId)).toEqual([1002])
        expect(visits.mock.calls.length).toBeLessThanOrEqual(2)
        visits.mockClear()
        expect(await writer.findTransactions({
          partial: { userId: 2, reference: 'reference-1002' }, noRawTx: true
        })).toEqual([])
        expect(visits.mock.calls.length).toBeLessThanOrEqual(2)
        visits.mockClear()
        expect((await writer.findTransactions({
          partial: { userId: 1, noSendExpiryReclaimTxid: reclaimTxid }, noRawTx: true
        })).map(row => row.transactionId)).toEqual([1002, 1003])
        expect(visits.mock.calls.length).toBeLessThanOrEqual(4)
        expect((await writer.findTransactions({
          partial: { userId: 1, txid: targetTxid }, paged: { offset: 1, limit: 1 }, noRawTx: true
        })).map(row => row.transactionId)).toEqual([1003])
        expect((await writer.findTransactions({
          partial: { userId: 1, txid: targetTxid }, orderDescending: true, noRawTx: true
        })).map(row => row.transactionId)).toEqual([1003, 1002])
      } finally {
        visits.mockRestore()
      }
    } finally {
      await writer.destroy()
      await deleteDB(writer.dbName)
    }
  })

  test('commission and relation merges do not scan unrelated wallet rows', async () => {
    const writer = storage()
    await writer.migrate('Synthetic relation lookups', identity)
    try {
      const seed = writer.db!.transaction(['commissions', 'output_tags_map', 'tx_labels_map'], 'readwrite')
      const timestamps = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
      for (let id = 1; id <= 1000; id++) {
        await seed.objectStore('commissions').put({
          ...timestamps, commissionId: id, transactionId: id, userId: 1,
          satoshis: 1, keyOffset: 'synthetic', isRedeemed: false, lockingScript: [81]
        })
        await seed.objectStore('output_tags_map').put({
          ...timestamps, outputTagId: 1, outputId: id, isDeleted: false
        })
        await seed.objectStore('tx_labels_map').put({
          ...timestamps, txLabelId: id, transactionId: 1, isDeleted: false
        })
      }
      await seed.done
      const commissions = jest.spyOn(idbHelpers, 'matchesCommissionPartial')
      const tags = jest.spyOn(idbHelpers, 'matchesOutputTagMapPartial')
      const labels = jest.spyOn(idbHelpers, 'matchesTxLabelMapPartial')
      try {
        expect((await writer.findCommissions({ partial: { userId: 1, transactionId: 500 } }))
          .map(row => row.commissionId)).toEqual([500])
        expect(commissions.mock.calls).toHaveLength(1)
        expect(await writer.findCommissions({ partial: { userId: 2, transactionId: 500 } })).toEqual([])
        expect(commissions.mock.calls).toHaveLength(2)
        expect(await writer.findOutputTagMaps({ partial: { outputTagId: 1, outputId: 500 } })).toHaveLength(1)
        expect(tags.mock.calls).toHaveLength(1)
        expect(await writer.findOutputTagMaps({ partial: { outputTagId: 1, outputId: 500, isDeleted: true } })).toEqual([])
        expect(tags.mock.calls).toHaveLength(2)
        expect(await writer.findTxLabelMaps({ partial: { txLabelId: 500, transactionId: 1 } })).toHaveLength(1)
        expect(labels.mock.calls).toHaveLength(1)
      } finally {
        commissions.mockRestore()
        tags.mockRestore()
        labels.mockRestore()
      }
    } finally {
      await writer.destroy()
      await deleteDB(writer.dbName)
    }
  })

  test('proof batches skip unrelated rows and preserve ordered, user-scoped filtering', async () => {
    const writer = storage()
    await writer.migrate('Synthetic proof lookups', identity)
    const txid = (id: number): string => id.toString(16).padStart(64, '0')
    try {
      const seed = writer.db!.transaction(['proven_txs', 'transactions'], 'readwrite')
      for (let id = 1; id <= 1000; id++) {
        await seed.objectStore('proven_txs').put({
          provenTxId: id, txid: txid(id), height: id, index: 0,
          created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
          blockHash: 'ab'.repeat(32), merkleRoot: 'cd'.repeat(32),
          rawTx: [1, 2, 3], merklePath: [4, 5, 6]
        })
      }
      for (let id = 1; id <= 1000; id++) {
        await seed.objectStore('transactions').put(transaction(id, { userId: id === 900 ? 2 : 1, provenTxId: id }))
      }
      await seed.done
      const visits = jest.spyOn(idbHelpers, 'matchesProvenTxPartial')
      try {
        const txids = [txid(900), txid(500), txid(900), txid(2000)]
        const found = await writer.findProvenTxs({ partial: {}, txids })
        expect(found.map(row => row.provenTxId)).toEqual([500, 900])
        expect(visits.mock.calls).toHaveLength(2)
        expect(found[0].rawTx).toEqual([1, 2, 3])
        expect(found[0].merklePath).toEqual([4, 5, 6])
        expect((await writer.findProvenTxs({ partial: {}, txids, orderDescending: true }))
          .map(row => row.provenTxId)).toEqual([900, 500])
        expect((await writer.findProvenTxs({ partial: {}, txids, paged: { offset: 1, limit: 1 } }))
          .map(row => row.provenTxId)).toEqual([900])
        expect((await writer.findProvenTxs({ partial: { height: 900 }, txids, paged: { offset: 0, limit: 1 } }))
          .map(row => row.provenTxId)).toEqual([900])
        expect(await writer.findProvenTxs({ partial: {}, txids, since: new Date('2026-01-02') })).toEqual([])
        expect(await writer.findProvenTxs({ partial: { provenTxId: 500 }, txids: [txid(900)] })).toEqual([])
        expect(await writer.findProvenTxs({ partial: { txid: txid(500) }, txids: [txid(900)] })).toEqual([])
        visits.mockClear()
        expect(await writer.findProvenTxs({ partial: {}, txids: [txid(2000)] })).toEqual([])
        expect(visits.mock.calls).toHaveLength(0)
        const userRows: TableProvenTx[] = []
        const ownershipVisits = jest.spyOn(idbHelpers, 'matchesTransactionPartial')
        try {
          await writer.filterProvenTxs({ partial: {}, txids }, row => userRows.push(row), 1)
          expect(userRows.map(row => row.provenTxId)).toEqual([500])
          expect(ownershipVisits.mock.calls).toHaveLength(2)
        } finally {
          ownershipVisits.mockRestore()
        }
        expect(await writer.findProvenTxs({ partial: {}, txids: [], paged: { offset: 0, limit: 2 } }))
          .toHaveLength(2)
      } finally {
        visits.mockRestore()
      }
    } finally {
      await writer.destroy()
      await deleteDB(writer.dbName)
    }
  })

  test('upgrades version 5 without losing existing bytes or rejecting duplicate txids', async () => {
    const writer = storage()
    const rows = [transaction(1, { txid: targetTxid }), transaction(2, { txid: targetTxid })]
    const old = await openDB<StorageIdbSchema>(writer.dbName, 5, {
      upgrade(db) { idbHelpers.upgradeAllStoresV1(db) }
    })
    for (const row of rows) await old.put('transactions', row)
    old.close()
    try {
      expect(await writer.migrate('Synthetic version 5 wallet', identity)).toBe('6')
      expect(await writer.db!.getAll('transactions')).toEqual(rows)
      expect((await writer.findTransactions({
        partial: { userId: 1, txid: targetTxid }, noRawTx: true
      })).map(row => row.transactionId)).toEqual([1, 2])
      await writer.destroy()
      await writer.makeAvailable()
      expect(await writer.db!.getAll('transactions')).toEqual(rows)
    } finally {
      await writer.destroy()
      await deleteDB(writer.dbName)
    }
  })
})
