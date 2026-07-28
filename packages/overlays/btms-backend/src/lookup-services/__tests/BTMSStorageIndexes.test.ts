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
})
