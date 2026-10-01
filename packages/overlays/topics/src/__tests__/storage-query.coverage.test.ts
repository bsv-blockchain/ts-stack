import { jest } from '@jest/globals'
import type { Collection, Db } from 'mongodb'
import { Bsv21StorageManager } from '../bsv21/Bsv21StorageManager.js'
import { DstasStorageManager } from '../dstas/DstasStorageManager.js'
import { lookupByOwnerOrOutpoint } from '../shared/tokenLookupTail.js'
import { StasStorageManager } from '../stas/StasStorageManager.js'

const txid = 'ab'.repeat(32)

interface CursorHarness {
  db: Db
  find: jest.Mock
  sort: jest.Mock
  skip: jest.Mock
  limit: jest.Mock
  project: jest.Mock
}

function cursorHarness(rows = [{ txid, outputIndex: 2 }]): CursorHarness {
  const cursor: Record<string, jest.Mock> = {}
  const sort = jest.fn(() => cursor)
  const skip = jest.fn(() => cursor)
  const limit = jest.fn(() => cursor)
  const project = jest.fn(() => cursor)
  const toArray = jest.fn(async () => rows)
  Object.assign(cursor, { sort, skip, limit, project, toArray })
  const find = jest.fn(() => cursor)
  const collection = {
    createIndex: jest.fn(async () => 'index'),
    find,
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
    findOne: jest.fn()
  } as unknown as Collection
  const db = { collection: jest.fn(() => collection) } as unknown as Db
  return { db, find, sort, skip, limit, project }
}

describe('bounded storage query construction', () => {
  it('propagates BSV-21 and STAS filters with default and caller pagination', async () => {
    const bsv = cursorHarness()
    const bsvStorage = new Bsv21StorageManager(bsv.db)
    await bsvStorage.findByTokenId('token-id')
    await bsvStorage.findByOwner('owner', 7, 4)
    await bsvStorage.findByOutpoint(txid, 2)
    expect(bsv.find.mock.calls.map(call => call[0])).toEqual([
      { tokenId: 'token-id' },
      { ownerHash160: 'owner' },
      { txid, outputIndex: 2 }
    ])
    expect(bsv.limit.mock.calls.map(call => call[0])).toEqual([100, 7, 100])
    expect(bsv.skip.mock.calls.map(call => call[0])).toEqual([0, 4, 0])

    const stas = cursorHarness()
    const stasStorage = new StasStorageManager(stas.db)
    await stasStorage.findByAssetId('asset-id')
    await stasStorage.findByOwner('owner', 8, 5)
    await stasStorage.findByOutpoint(txid, 2)
    expect(stas.find.mock.calls.map(call => call[0])).toEqual([
      { assetId: 'asset-id' },
      { ownerHash160: 'owner' },
      { txid, outputIndex: 2 }
    ])
    expect(stas.limit.mock.calls.map(call => call[0])).toEqual([100, 8, 100])
    expect(stas.skip.mock.calls.map(call => call[0])).toEqual([0, 5, 0])
  })

  it('adds a DSTAS frozen predicate only when the caller supplies one', async () => {
    const { db, find, limit, skip } = cursorHarness()
    const storage = new DstasStorageManager(db)

    await storage.findByTokenId('token-id')
    await storage.findByTokenId('token-id', false, 6, 2)
    await storage.findByOwner('owner', true)

    expect(find.mock.calls.map(call => call[0])).toEqual([
      { tokenId: 'token-id' },
      { tokenId: 'token-id', frozen: false },
      { ownerHash160: 'owner', frozen: true }
    ])
    expect(limit.mock.calls.map(call => call[0])).toEqual([100, 6, 100])
    expect(skip.mock.calls.map(call => call[0])).toEqual([0, 2, 0])
  })

  it('routes shared token lookup tails without ambiguous fallthrough', async () => {
    const storage = {
      findByOwner: jest.fn(async () => [{ txid, outputIndex: 1 }]),
      findByOutpoint: jest.fn(async () => [{ txid, outputIndex: 2 }])
    }

    await expect(
      lookupByOwnerOrOutpoint(storage, { ownerHash160: 'owner', txid, outputIndex: 2 })
    ).resolves.toEqual([{ txid, outputIndex: 1 }])
    expect(storage.findByOwner).toHaveBeenCalledWith('owner', 100, 0)
    expect(storage.findByOutpoint).not.toHaveBeenCalled()

    await expect(lookupByOwnerOrOutpoint(storage, { txid, outputIndex: 2 }, 7, 3)).resolves.toEqual(
      [{ txid, outputIndex: 2 }]
    )
    expect(storage.findByOutpoint).toHaveBeenCalledWith(txid, 2)
    await expect(lookupByOwnerOrOutpoint(storage, { txid })).rejects.toThrow('Unsupported query')
  })
})
