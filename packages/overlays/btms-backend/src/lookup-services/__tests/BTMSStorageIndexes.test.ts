import type { Db } from 'mongodb'

import { BTMSStorageManager } from '../BTMSStorageManager'

describe('BTMS storage index initialization', () => {
  test('creates its indexes once across repeated operations', async () => {
    const createIndex = jest.fn(async () => 'index')
    const deleteOne = jest.fn(async () => ({ acknowledged: true, deletedCount: 0 }))
    const db = {
      collection: jest.fn(() => ({ createIndex, deleteOne }))
    } as unknown as Db
    const storage = new BTMSStorageManager(db)

    await storage.deleteRecord('txid', 0)
    await storage.deleteRecord('txid', 0)

    expect(createIndex).toHaveBeenCalledTimes(3)
    expect(deleteOne).toHaveBeenCalledTimes(2)
  })

  test('retries index initialization after a transient failure', async () => {
    let fail = true
    const createIndex = jest.fn(async () => {
      if (fail) throw new Error('transient index failure')
      return 'index'
    })
    const deleteOne = jest.fn(async () => ({ acknowledged: true, deletedCount: 0 }))
    const db = {
      collection: jest.fn(() => ({ createIndex, deleteOne }))
    } as unknown as Db
    const storage = new BTMSStorageManager(db)

    await expect(storage.deleteRecord('txid', 0)).rejects.toThrow('transient index failure')
    fail = false
    await expect(storage.deleteRecord('txid', 0)).resolves.toBeUndefined()

    expect(deleteOne).toHaveBeenCalledTimes(1)
  })

  test('accepts identical admission replay and rejects conflicting content', async () => {
    const record = {
      txid: 'txid',
      outputIndex: 0,
      assetId: 'asset.0',
      amount: 10,
      ownerKey: `02${'11'.repeat(32)}`,
      metadata: 'metadata',
      createdAt: new Date()
    }
    const createIndex = jest.fn(async () => 'index')
    const updateOne = jest
      .fn()
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValue({ upsertedCount: 0 })
    const findOne = jest.fn(async () => record)
    const db = {
      collection: jest.fn(() => ({ createIndex, updateOne, findOne }))
    } as unknown as Db
    const storage = new BTMSStorageManager(db)

    await storage.storeRecord(
      record.txid,
      record.outputIndex,
      record.assetId,
      record.amount,
      record.ownerKey,
      record.metadata
    )
    await expect(
      storage.storeRecord(
        record.txid,
        record.outputIndex,
        record.assetId,
        record.amount,
        record.ownerKey,
        record.metadata
      )
    ).resolves.toBeUndefined()
    await expect(
      storage.storeRecord(
        record.txid,
        record.outputIndex,
        record.assetId,
        record.amount + 1,
        record.ownerKey,
        record.metadata
      )
    ).rejects.toThrow('Conflicting BTMS record replay')
  })
})
