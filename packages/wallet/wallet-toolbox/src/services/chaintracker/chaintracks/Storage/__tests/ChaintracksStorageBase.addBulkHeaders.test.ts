import { BlockHeader } from '../../Api/BlockHeaderApi'
import { HeightRange } from '../../util/HeightRange'
import { deserializeBlockHeader } from '../../util/blockHeaderUtilities'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { readFileSync } from 'node:fs'

const fixture = new Uint8Array(
  readFileSync('src/services/chaintracker/chaintracks/__tests/data/cdnTest499/mainNet_0.headers')
)

function makeHeader(height: number): BlockHeader {
  return deserializeBlockHeader(fixture, height, height * 80)
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
  it('routes historical reads through the managed cache and budget path', async () => {
    const storage = makeStorage(new HeightRange(0, 9))
    const data = new Uint8Array(10 * 80)
    const read = jest.fn(async () => data)
    const createReader = jest.fn(async () => ({ read }))
    storage.bulkManager = { createReader } as any
    const range = new HeightRange(0, 9)

    await expect(storage.getBulkHeaders(range)).resolves.toBe(data)
    expect(createReader).toHaveBeenCalledWith(range, 10 * 80)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('selects a validated chain, ignores duplicate tips, and retains live headers', async () => {
    const mergeIncrementalBlockHeaders = jest.fn(async () => {})
    const storage = makeStorage(new HeightRange(0, -1), mergeIncrementalBlockHeaders)
    const h0 = makeHeader(0)
    const h1 = makeHeader(1)
    const h2 = makeHeader(2)

    const live = await storage.addBulkHeaders([h0, h1, { ...h1 }, h2], new HeightRange(0, 1), [])

    expect(live).toEqual([h2])
    expect(mergeIncrementalBlockHeaders).toHaveBeenCalledTimes(1)
    expect(mergeIncrementalBlockHeaders.mock.calls[0][0]).toEqual([h0, h1])
    expect(mergeIncrementalBlockHeaders.mock.calls[0][1]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the next live height from empty and populated bulk storage', async () => {
    const header0 = makeHeader(0)
    const emptyStorage = makeStorage(new HeightRange(0, -1))
    await expect(emptyStorage.addBulkHeaders([header0], new HeightRange(0, -1), [])).resolves.toEqual([header0])

    const header10 = makeHeader(10)
    const populatedStorage = makeStorage(new HeightRange(0, 9))
    await expect(populatedStorage.addBulkHeaders([header10], new HeightRange(0, -1), [])).resolves.toEqual([header10])
  })

  it('rejects forged and proof-invalid candidates before chain-work selection', async () => {
    const mergeIncrementalBlockHeaders = jest.fn(async () => {})
    const storage = makeStorage(new HeightRange(0, -1), mergeIncrementalBlockHeaders)
    const forged = { ...makeHeader(0), hash: '11'.repeat(32) }
    await expect(storage.addBulkHeaders([forged], new HeightRange(0, 0), [])).rejects.toThrow('hash is invalid')

    const invalidBytes = fixture.slice(0, 80)
    invalidBytes[76] ^= 1
    const proofInvalid = deserializeBlockHeader(invalidBytes, 0)
    await expect(storage.addBulkHeaders([proofInvalid], new HeightRange(0, 0), [])).rejects.toThrow(
      'not less than specified target'
    )
    expect(mergeIncrementalBlockHeaders).not.toHaveBeenCalled()
  })

  it('accepts trusted live metadata only after reducing it to canonical header fields', async () => {
    const storage = makeStorage(new HeightRange(0, -1))
    const liveHeader = {
      ...makeHeader(0),
      chainWork: '00'.repeat(32),
      isChainTip: true,
      isActive: true,
      headerId: 1,
      previousHeaderId: null
    }

    const [result] = await storage.addBulkHeaders([], new HeightRange(0, -1), [liveHeader])
    expect(result).toEqual(makeHeader(0))
    expect(result).not.toHaveProperty('headerId')
  })
})
