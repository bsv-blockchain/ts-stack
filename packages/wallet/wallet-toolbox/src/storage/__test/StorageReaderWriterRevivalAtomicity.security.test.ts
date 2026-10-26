import { StorageReaderWriter } from '../StorageReaderWriter'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { EntitySyncState } from '../schema/entities/EntitySyncState'

function fakeStorage (overrides: Record<string, unknown>): StorageReaderWriter {
  const storage = Object.create(StorageReaderWriter.prototype) as StorageReaderWriter & Record<string, unknown>
  Object.assign(storage, overrides)
  return storage
}

describe('soft-deleted wallet metadata revival atomicity', () => {
  const trx = { token: 'caller transaction' }
  const now = new Date()

  test('revives an output basket in the caller transaction', async () => {
    const updateOutputBasket = jest.fn().mockResolvedValue(1)
    const storage = fakeStorage({
      findOutputBaskets: jest.fn().mockResolvedValue([{
        basketId: 11,
        userId: 7,
        name: 'archive',
        numberOfDesiredUTXOs: 0,
        minimumDesiredUTXOValue: 0,
        isDeleted: true,
        created_at: now,
        updated_at: now
      }]),
      updateOutputBasket
    })

    await storage.findOrInsertOutputBasket(7, 'archive', trx as never)

    expect(updateOutputBasket).toHaveBeenCalledWith(11, { isDeleted: false }, trx)
  })

  test('revives a transaction label in the caller transaction', async () => {
    const updateTxLabel = jest.fn().mockResolvedValue(1)
    const storage = fakeStorage({
      findTxLabels: jest.fn().mockResolvedValue([{
        txLabelId: 12,
        userId: 7,
        label: 'archive',
        isDeleted: true,
        created_at: now,
        updated_at: now
      }]),
      updateTxLabel
    })

    await storage.findOrInsertTxLabel(7, 'archive', trx as never)

    expect(updateTxLabel).toHaveBeenCalledWith(12, { isDeleted: false }, trx)
  })

  test('revives a transaction-label mapping in the caller transaction', async () => {
    const updateTxLabelMap = jest.fn().mockResolvedValue(1)
    const storage = fakeStorage({
      findTxLabelMaps: jest.fn().mockResolvedValue([{
        transactionId: 13,
        txLabelId: 12,
        isDeleted: true,
        created_at: now,
        updated_at: now
      }]),
      updateTxLabelMap
    })

    await storage.findOrInsertTxLabelMap(13, 12, trx as never)

    expect(updateTxLabelMap).toHaveBeenCalledWith(13, 12, { isDeleted: false }, trx)
  })

  test('revives an output tag in the caller transaction', async () => {
    const updateOutputTag = jest.fn().mockResolvedValue(1)
    const storage = fakeStorage({
      findOutputTags: jest.fn().mockResolvedValue([{
        outputTagId: 14,
        userId: 7,
        tag: 'archive',
        isDeleted: true,
        created_at: now,
        updated_at: now
      }]),
      updateOutputTag
    })

    await storage.findOrInsertOutputTag(7, 'archive', trx as never)

    expect(updateOutputTag).toHaveBeenCalledWith(14, { isDeleted: false }, trx)
  })

  test('revives an output-tag mapping in the caller transaction', async () => {
    const updateOutputTagMap = jest.fn().mockResolvedValue(1)
    const storage = fakeStorage({
      findOutputTagMaps: jest.fn().mockResolvedValue([{
        outputId: 15,
        outputTagId: 14,
        isDeleted: true,
        created_at: now,
        updated_at: now
      }]),
      updateOutputTagMap
    })

    await storage.findOrInsertOutputTagMap(15, 14, trx as never)

    expect(updateOutputTagMap).toHaveBeenCalledWith(15, 14, { isDeleted: false }, trx)
  })

  test('inserts a new proof request in the caller transaction', async () => {
    const insertProvenTxReq = jest.fn().mockImplementation(async api => {
      api.provenTxReqId = 16
      return 16
    })
    const updateProvenTxReq = jest.fn().mockResolvedValue(1)
    const req = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: now,
      updated_at: now,
      txid: '1'.repeat(64),
      rawTx: [1],
      history: '{}',
      notify: '{}',
      attempts: 0,
      status: 'unknown',
      notified: false
    })

    await req.updateStorage({ insertProvenTxReq, updateProvenTxReq } as never, trx as never)

    expect(insertProvenTxReq).toHaveBeenCalledWith(expect.any(Object), trx)
    expect(updateProvenTxReq).toHaveBeenCalledWith(16, expect.any(Object), trx)
  })

  test('inserts a new sync state in the caller transaction', async () => {
    const insertSyncState = jest.fn().mockImplementation(async api => {
      api.syncStateId = 17
      return 17
    })
    const state = new EntitySyncState()
    state.userId = 7
    state.refNum = 'atomic-sync-state'

    await state.updateStorage({ insertSyncState } as never, false, trx as never)

    expect(insertSyncState).toHaveBeenCalledWith(expect.any(Object), trx)
  })
})
