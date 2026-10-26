import { BlockHeader, LiveBlockHeader } from '../../Api/BlockHeaderApi'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { ChaintracksStorageNoDb } from '../ChaintracksStorageNoDb'
import { deserializeBlockHeader, genesisBuffer } from '../../util/blockHeaderUtilities'
import { BulkFileDataManager } from '../../util/BulkFileDataManager'
import { HeightRange } from '../../util/HeightRange'

class BehaviorChaintracksStorageNoDb extends ChaintracksStorageNoDb {
  protected override validateIncomingHeader(header: BlockHeader): BlockHeader {
    return { ...header }
  }

  validateStoredHeaderForTest(header: LiveBlockHeader, allowUnassignedHeaderId = false): LiveBlockHeader {
    return this.validateLiveHeaderRecord(header, allowUnassignedHeaderId)
  }

  recordVisitForTest(seen: Set<number>, header: LiveBlockHeader): void {
    this.recordTraversalVisit(seen, header, 'testing traversal safety')
  }

  validateParentForTest(child: LiveBlockHeader, parent: LiveBlockHeader): void {
    this.validateStoredParentLink(child, parent)
  }
}

describe('ChaintracksStorageNoDb insertHeader compatibility', () => {
  const makeHeader = (height: number, hashByte: string, previousHash: string): BlockHeader => ({
    height,
    hash: hashByte.repeat(64),
    version: 1,
    previousHash,
    merkleRoot: '11'.repeat(32),
    time: height,
    bits: 0x1d00ffff,
    nonce: height
  })

  let storage: ChaintracksStorageNoDb

  beforeEach(async () => {
    storage = new BehaviorChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('main'))
    await storage.deleteLiveBlockHeaders()
  })

  afterEach(async () => {
    await storage.deleteLiveBlockHeaders()
  })

  test('preserves first-header, duplicate, invalid-parent, linear, fork, and reorg results', async () => {
    const bulkTipHash = 'a0'.repeat(32)
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'test.headers',
      firstHeight: 0,
      count: 100,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: bulkTipHash,
      fileHash: null
    })
    const first = makeHeader(100, 'b', bulkTipHash)
    const main = makeHeader(101, 'c', first.hash)
    const fork = makeHeader(101, 'd', first.hash)
    const forkTip = makeHeader(102, 'e', fork.hash)

    await expect(storage.insertHeader(first)).resolves.toMatchObject({
      added: true,
      isActiveTip: true
    })
    await expect(storage.insertHeader(first)).resolves.toMatchObject({
      added: false,
      dupe: true
    })
    await expect(storage.insertHeader(makeHeader(101, 'f', 'ff'.repeat(32)))).resolves.toMatchObject({
      added: false,
      noPrev: true
    })
    await expect(storage.insertHeader(makeHeader(103, '1', first.hash))).resolves.toMatchObject({
      added: false,
      badPrev: true
    })
    await expect(storage.insertHeader(main)).resolves.toMatchObject({
      added: true,
      isActiveTip: true
    })
    await expect(storage.insertHeader(fork)).resolves.toMatchObject({
      added: true,
      isActiveTip: false
    })

    const reorg = await storage.insertHeader(forkTip)
    expect(reorg).toMatchObject({
      added: true,
      isActiveTip: true,
      reorgDepth: 1
    })
    expect(reorg.deactivatedHeaders.map(header => header.hash)).toEqual([main.hash])
    await expect(storage.findChainTipHeader()).resolves.toMatchObject({
      hash: forkTip.hash
    })
    const priorTip = reorg.deactivatedHeaders[0]
    const activeTip = await storage.findChainTipHeader()
    await expect(storage.findCommonAncestor(priorTip, activeTip)).resolves.toMatchObject({ hash: first.hash })
    await expect(storage.findReorgDepth(priorTip, activeTip)).resolves.toBe(2)
    await expect(storage.findCommonAncestor({ ...priorTip, hash: 'ff'.repeat(32) }, activeTip)).rejects.toThrow(
      'matching the stored live header'
    )
  })

  test('does not accept a first live header without a matching bulk tip', async () => {
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue(undefined)
    await expect(storage.insertHeader(makeHeader(100, 'b', 'a0'.repeat(32)))).rejects.toThrow('bulk headers must exist')

    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'test.headers',
      firstHeight: 0,
      count: 100,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: 'a0'.repeat(32),
      fileHash: null
    })
    await expect(storage.insertHeader(makeHeader(101, 'c', 'a0'.repeat(32)))).resolves.toMatchObject({
      added: false,
      noPrev: true
    })
  })

  test('serializes concurrent first-header installation across an async bulk lookup', async () => {
    const bulkTipHash = 'a0'.repeat(32)
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'test.headers',
      firstHeight: 0,
      count: 100,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: bulkTipHash,
      fileHash: null
    })

    const results = await Promise.all([
      storage.insertHeader(makeHeader(100, 'b', bulkTipHash)),
      storage.insertHeader(makeHeader(100, 'c', bulkTipHash))
    ])
    expect(results.filter(result => result.added)).toHaveLength(1)
    expect(results.filter(result => result.noPrev)).toHaveLength(1)
    await expect(storage.findChainTipHeader()).resolves.toMatchObject({ isActive: true, isChainTip: true })
  })

  test('keeps in-memory state isolated for every supported network', async () => {
    const chains = ['main', 'test', 'stn', 'ttn', 'tstn'] as const
    const stores = chains.map(
      chain => new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions(chain))
    )
    const datasets = await Promise.all(stores.map(async store => await store.getData()))

    for (const [index, data] of datasets.entries()) {
      expect(data.chain).toBe(chains[index])
      for (const [otherIndex, other] of datasets.entries()) {
        if (otherIndex !== index) {
          expect(data).not.toBe(other)
          expect(data.liveHeaders).not.toBe(other.liveHeaders)
          expect(data.hashToHeaderId).not.toBe(other.hashToHeaderId)
        }
      }
    }
  })

  test('isolates independent same-network instances', async () => {
    const one = new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('main'))
    const two = new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('main'))
    const oneData = await one.getData()
    const twoData = await two.getData()

    oneData.maxHeaderId = 99
    expect(twoData).not.toBe(oneData)
    expect(twoData.liveHeaders).not.toBe(oneData.liveHeaders)
    expect(twoData.maxHeaderId).toBe(0)
    expect((await one.getData()).maxHeaderId).toBe(0)
  })

  test('authenticates a direct storage insertion before changing in-memory state', async () => {
    const secure = new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('main'))
    const genesis = deserializeBlockHeader(genesisBuffer('main'), 0)
    jest.spyOn(secure.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'bootstrap.headers',
      firstHeight: 0,
      count: 0,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '00'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: '00'.repeat(32),
      fileHash: null
    })

    await expect(secure.insertHeader(genesis)).resolves.toMatchObject({ added: true })
    await expect(secure.insertHeader({ ...genesis, nonce: genesis.nonce + 1 })).rejects.toThrow(
      'Header hash is invalid'
    )
    expect((await secure.getData()).liveHeaders.size).toBe(1)
    const returned = await secure.findChainTipHeader()
    returned.hash = 'ff'.repeat(32)
    await expect(secure.findChainTipHeader()).resolves.toMatchObject({ hash: genesis.hash })
  })

  test('rejects mock storage before it can share a public-network data set', async () => {
    const mockStorage = new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('mock'))

    await expect(mockStorage.getData()).rejects.toThrow("'mock' is unsupported")
  })

  test('rejects unsafe configuration, mismatched managers, and public query ranges', async () => {
    const invalidThreshold = ChaintracksStorageBase.createStorageBaseOptions('main')
    invalidThreshold.liveHeightThreshold = 0
    expect(() => new ChaintracksStorageNoDb(invalidThreshold)).toThrow('liveHeightThreshold')

    const mismatchedManager = ChaintracksStorageBase.createStorageBaseOptions('main')
    mismatchedManager.bulkFileDataManager = new BulkFileDataManager({ chain: 'test', maxPerFile: 100 })
    expect(() => new ChaintracksStorageNoDb(mismatchedManager)).toThrow('bulkFileDataManager')

    await expect(storage.getHeadersUint8Array(0, 0)).rejects.toThrow('count')
    await expect(storage.getLiveHeaders(new HeightRange(0, 100_000))).rejects.toThrow('range')
  })

  test('rejects every unsafe storage configuration boundary', () => {
    for (const [field, value] of [
      ['chain', 'mainnet'],
      ['reorgHeightThreshold', -1],
      ['reorgHeightThreshold', 2001],
      ['bulkMigrationChunkSize', 0],
      ['bulkMigrationChunkSize', 100_001],
      ['batchInsertLimit', Number.NaN],
      ['batchInsertLimit', 100_001]
    ] as const) {
      const options = ChaintracksStorageBase.createStorageBaseOptions('main') as Record<string, unknown>
      options[field] = value
      expect(() => new ChaintracksStorageNoDb(options as never)).toThrow(field)
    }
  })

  test('validates stored live-header metadata and returns an owned canonical value', () => {
    const header: LiveBlockHeader = {
      ...makeHeader(1, 'b', 'aa'.repeat(32)),
      headerId: 1,
      previousHeaderId: null,
      chainWork: '00'.repeat(32),
      isActive: true,
      isChainTip: false
    }
    const behavior = storage as BehaviorChaintracksStorageNoDb
    expect(behavior.validateStoredHeaderForTest(header)).toEqual(header)
    expect(behavior.validateStoredHeaderForTest({ ...header, headerId: 0 }, true)).toMatchObject({ headerId: 0 })

    for (const value of [null, []]) {
      expect(() => behavior.validateStoredHeaderForTest(value as never)).toThrow('plain data object')
    }
    for (const invalid of [
      { ...header, headerId: 0 },
      { ...header, previousHeaderId: 0 },
      { ...header, chainWork: 'AA'.repeat(32) },
      { ...header, isActive: 1 as never },
      { ...header, isChainTip: null as never }
    ]) {
      expect(() => behavior.validateStoredHeaderForTest(invalid)).toThrow()
    }
  })

  test('detects cycles, excessive traversals, and corrupt stored parent links', () => {
    const parent: LiveBlockHeader = {
      ...makeHeader(1, 'a', '00'.repeat(32)),
      headerId: 1,
      previousHeaderId: null,
      chainWork: '00'.repeat(32),
      isActive: true,
      isChainTip: false
    }
    const child: LiveBlockHeader = {
      ...makeHeader(2, 'b', parent.hash),
      headerId: 2,
      previousHeaderId: 1,
      chainWork: '01'.repeat(32),
      isActive: true,
      isChainTip: true
    }
    const behavior = storage as BehaviorChaintracksStorageNoDb
    expect(() => behavior.validateParentForTest(child, parent)).not.toThrow()
    expect(() => behavior.validateParentForTest({ ...child, previousHash: 'ff'.repeat(32) }, parent)).toThrow(
      'invalid parent link'
    )
    expect(() => behavior.recordVisitForTest(new Set([child.headerId]), child)).toThrow('cycle detected')
    expect(() =>
      behavior.recordVisitForTest(new Set(Array.from({ length: 100_000 }, (_, index) => index + 10)), child)
    ).toThrow('traversal exceeded')
  })

  test('validates migration controls before reading or mutating storage', async () => {
    const behavior = storage as BehaviorChaintracksStorageNoDb
    await expect(behavior.migrateLiveToBulk(0)).rejects.toThrow('count')
    await expect(behavior.migrateLiveToBulk(100_001)).rejects.toThrow('count')
    await expect(behavior.migrateLiveToBulk(1, 'yes' as never)).rejects.toThrow('ignoreLimits')
    const liveHeaders = jest.spyOn(behavior, 'liveHeadersForBulk')
    await expect(behavior.migrateLiveToBulk(501)).resolves.toBeUndefined()
    expect(liveHeaders).not.toHaveBeenCalled()
  })

  test('disconnects surviving headers from live ancestors that are pruned', async () => {
    const bulkTipHash = 'a0'.repeat(32)
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'test.headers',
      firstHeight: 0,
      count: 100,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: bulkTipHash,
      fileHash: null
    })
    const first = makeHeader(100, 'b', bulkTipHash)
    const second = makeHeader(101, 'c', first.hash)

    await storage.insertHeader(first)
    await storage.insertHeader(second)

    await expect(storage.deleteOlderLiveBlockHeaders(100)).resolves.toBe(1)
    await expect(storage.findLiveHeaderForBlockHash(first.hash)).resolves.toBeNull()
    await expect(storage.findLiveHeaderForBlockHash(second.hash)).resolves.toMatchObject({
      previousHeaderId: null
    })
  })

  test('does not expose mutable diagnostic maps or stored-header references', async () => {
    const bulkTipHash = 'a0'.repeat(32)
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
      chain: 'main',
      fileName: 'test.headers',
      firstHeight: 0,
      count: 100,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: bulkTipHash,
      fileHash: null
    })
    const first = makeHeader(100, 'b', bulkTipHash)
    const second = makeHeader(101, 'c', first.hash)

    await storage.insertHeader(first)
    await storage.insertHeader(second)
    const persistedFirst = await storage.findLiveHeaderForBlockHash(first.hash)
    if (persistedFirst == null) throw new Error('Expected the first live header to be persisted')
    const data = await storage.getData()
    data.liveHeaders.delete(persistedFirst.headerId)
    const snapshotSecond = Array.from(data.liveHeaders.values()).find(header => header.hash === second.hash)!
    snapshotSecond.previousHeaderId = null

    await expect(storage.findLiveHeaderForBlockHash(first.hash)).resolves.toMatchObject({ hash: first.hash })
    await expect(storage.findLiveHeaderForBlockHash(second.hash)).resolves.toMatchObject({
      previousHeaderId: persistedFirst.headerId
    })
  })
})
