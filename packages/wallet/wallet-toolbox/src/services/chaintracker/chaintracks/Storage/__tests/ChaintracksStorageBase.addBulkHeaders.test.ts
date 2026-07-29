import { BlockHeader } from '../../Api/BlockHeaderApi'
import { HeightRange } from '../../util/HeightRange'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'

function makeHeader(height: number, hashByte: string, previousHash: string): BlockHeader {
  return {
    height,
    hash: hashByte.repeat(64),
    version: 1,
    previousHash,
    merkleRoot: '11'.repeat(32),
    time: 1,
    bits: 0x1d00ffff,
    nonce: height
  }
}

function makeStorage(
  bulkRange: HeightRange,
  mergeIncrementalBlockHeaders = jest.fn(async () => {})
): ChaintracksStorageBase {
  const storage = Object.create(ChaintracksStorageBase.prototype) as ChaintracksStorageBase
  storage.makeAvailable = jest.fn(async () => {})
  storage.getAvailableHeightRanges = jest.fn(async () => ({
    bulk: bulkRange,
    live: new HeightRange(0, -1)
  }))
  storage.bulkManager = { mergeIncrementalBlockHeaders } as any
  return storage
}

describe('ChaintracksStorageBase.addBulkHeaders', () => {
  it('selects the most-work branch, ignores duplicate tips, and retains live headers', async () => {
    const mergeIncrementalBlockHeaders = jest.fn(async () => {})
    const storage = makeStorage(new HeightRange(0, -1), mergeIncrementalBlockHeaders)
    const h0 = makeHeader(0, 'a', '00'.repeat(32))
    const h1Original = makeHeader(1, 'b', h0.hash)
    const h1Fork = makeHeader(1, 'c', h0.hash)
    const h2Fork = makeHeader(2, 'd', h1Fork.hash)

    const live = await storage.addBulkHeaders(
      [h0, h1Original, h1Fork, { ...h1Fork }, h2Fork],
      new HeightRange(0, 1),
      []
    )

    expect(live).toEqual([h2Fork])
    expect(mergeIncrementalBlockHeaders).toHaveBeenCalledTimes(1)
    expect(mergeIncrementalBlockHeaders.mock.calls[0][0]).toEqual([h0, h1Fork])
    expect(mergeIncrementalBlockHeaders.mock.calls[0][1]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the next live height from empty and populated bulk storage', async () => {
    const header0 = makeHeader(0, 'a', '00'.repeat(32))
    const emptyStorage = makeStorage(new HeightRange(0, -1))
    await expect(emptyStorage.addBulkHeaders([header0], new HeightRange(0, -1), [])).resolves.toEqual([header0])

    const header10 = makeHeader(10, 'b', header0.hash)
    const populatedStorage = makeStorage(new HeightRange(0, 9))
    await expect(populatedStorage.addBulkHeaders([header10], new HeightRange(0, -1), [])).resolves.toEqual([header10])
  })
})
