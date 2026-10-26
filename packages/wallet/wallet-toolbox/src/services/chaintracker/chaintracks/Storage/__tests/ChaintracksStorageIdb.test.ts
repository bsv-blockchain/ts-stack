import 'fake-indexeddb/auto'
import { ChaintracksStorageIdb, ChaintracksStorageIdbOptions } from '../ChaintracksStorageIdb'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { LiveBlockHeader } from '../../Api/BlockHeaderApi'
import { BlockHeader } from '../../Api/BlockHeaderApi'
import { BulkFileDataManager } from '../../util/BulkFileDataManager'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { deserializeBlockHeader, genesisBuffer } from '../../util/blockHeaderUtilities'

class BehaviorChaintracksStorageIdb extends ChaintracksStorageIdb {
  protected override validateIncomingHeader(header: BlockHeader): BlockHeader {
    return { ...header }
  }

  protected override validateLiveHeaderRecord(header: LiveBlockHeader): LiveBlockHeader {
    return { ...header }
  }
}

describe('ChaintracksStorageIdb tests', () => {
  jest.setTimeout(99999999)

  let _logSpy: jest.SpyInstance
  const capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  test('atomically replaces bulk files and preserves omitted stored data', async () => {
    const options: ChaintracksStorageIdbOptions = ChaintracksStorageBase.createStorageBaseOptions('main')
    options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const storage = new BehaviorChaintracksStorageIdb(options)
    storage.dbName = `chaintracks-mainnet-atomic-test-${Date.now()}-${Math.random()}`
    await storage.makeAvailable()
    try {
      const file = {
        chain: 'main',
        fileName: 'idb-atomic.headers',
        firstHeight: 0,
        count: 1,
        prevChainWork: '00'.repeat(32),
        lastChainWork: '01'.repeat(32),
        prevHash: '00'.repeat(32),
        lastHash: '11'.repeat(32),
        fileHash: 'A'.repeat(43) + '=',
        data: Uint8Array.from([1, 2, 3, 4])
      } as const
      const fileId = await storage.insertBulkFile(file)
      await expect(
        storage.replaceBulkFiles([{ ...file, fileId, fileName: 'idb-preserved.headers', data: undefined }])
      ).resolves.toMatchObject([{ fileId, fileName: 'idb-preserved.headers' }])
      await expect(storage.getBulkFileData(fileId)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]))

      await expect(
        storage.replaceBulkFiles([
          { ...file, fileId, fileName: 'idb-must-rollback.headers', data: undefined },
          {
            ...file,
            fileId: fileId + 999,
            fileName: 'idb-missing-id.headers',
            fileHash: Buffer.alloc(32, 2).toString('base64'),
            firstHeight: 1,
            prevHash: file.lastHash,
            prevChainWork: file.lastChainWork,
            lastHash: '22'.repeat(32),
            lastChainWork: '02'.repeat(32)
          }
        ])
      ).rejects.toThrow('current bulk-file set')
      await expect(storage.getBulkFiles()).resolves.toMatchObject([{ fileId, fileName: 'idb-preserved.headers' }])
    } finally {
      storage.db?.close()
    }
  })

  test('0', async () => {
    const options: ChaintracksStorageIdbOptions = ChaintracksStorageBase.createStorageBaseOptions('main')
    const manager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const fixtureRoot = './src/services/chaintracker/chaintracks/__tests/data/cdnTest499'
    const fixtureInfo = JSON.parse(
      asString(await ChaintracksFs.readFile(ChaintracksFs.pathJoin(fixtureRoot, 'mainNetBlockHeaders.json')), 'utf8')
    )
    fixtureInfo.files[0].data = await ChaintracksFs.readFile(
      ChaintracksFs.pathJoin(fixtureRoot, fixtureInfo.files[0].fileName)
    )
    await manager.merge([fixtureInfo.files[0]])
    options.bulkFileDataManager = manager
    const storage = new BehaviorChaintracksStorageIdb(options)
    storage.dbName = `chaintracks-mainnet-test-${Date.now()}-${Math.random()}`
    const _r = await storage.migrateLatest()
    const db = storage.db!
    expect(db).toBeTruthy()

    const tip = await storage.findChainTipHeaderOrUndefined()
    expect(tip).toBeUndefined()

    const ranges = await storage.getAvailableHeightRanges()

    let lh: LiveBlockHeader = {
      headerId: 0,
      chainWork: '00'.repeat(32),
      isChainTip: false,
      isActive: true,
      previousHeaderId: null,
      height: ranges.bulk.maxHeight + 1,
      hash: '11'.repeat(32),
      version: 0,
      previousHash: '01'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 0,
      bits: 0,
      nonce: 0
    }
    lh = await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '22'.repeat(32)
    lh.merkleRoot = '22'.repeat(32)
    lh.height++
    lh = await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '33'.repeat(32)
    lh.merkleRoot = '33'.repeat(32)
    lh.height++
    lh = await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '44'.repeat(32)
    lh.height++
    lh = await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '55'.repeat(32)
    lh.height++
    lh.isChainTip = true
    lh = await storage.insertLiveHeader(lh)

    const h1 = await storage.findLiveHeaderForBlockHash('11'.repeat(32))
    expect(h1!.headerId).toBe(1)

    const h2 = await storage.findLiveHeaderForMerkleRoot('22'.repeat(32))
    expect(h2!.headerId).toBe(2)

    const h3 = await storage.findLiveHeaderForHeaderId(3)
    expect(h3.headerId).toBe(3)

    const h4 = await storage.findLiveHeaderForHeight(4 + ranges.bulk.maxHeight)
    expect(h4!.headerId).toBe(4)

    const h5 = await storage.findChainTipHeader()
    expect(h5.headerId).toBe(5)

    const range = await storage.findLiveHeightRange()
    expect(range).toEqual({ minHeight: 1 + ranges.bulk.maxHeight, maxHeight: 5 + ranges.bulk.maxHeight })

    const maxId = await storage.findMaxHeaderId()
    expect(maxId).toBe(5)

    const hfbs = await storage.liveHeadersForBulk(3)
    expect(hfbs).toHaveLength(3)

    const lhs = await storage.getHeaders(0, 10)
    expect(lhs).toHaveLength(10)

    const lhs2 = await storage.getHeaders(0 + ranges.bulk.maxHeight + 1, 10)
    expect(lhs2).toHaveLength(5)

    const lhs3 = await storage.getHeaders(0 + ranges.bulk.maxHeight - 2, 10)
    expect(lhs3).toHaveLength(8)

    const data = await storage.getHeadersUint8Array(0, 10)
    expect(data).toHaveLength(10 * 80)

    const deleteCount = await storage.deleteOlderLiveBlockHeaders(3 + ranges.bulk.maxHeight)
    expect(deleteCount).toBe(3)

    await storage.deleteLiveBlockHeaders()

    const lastBulkFile = await storage.bulkManager.getLastFile()
    expect(lastBulkFile?.lastHash).toBeTruthy()
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
    const firstHeight = lastBulkFile!.firstHeight + lastBulkFile!.count
    const first = makeHeader(firstHeight, 'a', lastBulkFile!.lastHash!)
    const main = makeHeader(firstHeight + 1, 'b', first.hash)
    const fork = makeHeader(firstHeight + 1, 'c', first.hash)
    const forkTip = makeHeader(firstHeight + 2, 'd', fork.hash)

    await expect(storage.insertHeader(first)).resolves.toMatchObject({
      added: true,
      isActiveTip: true
    })
    await expect(storage.insertHeader(first)).resolves.toMatchObject({
      added: false,
      dupe: true
    })
    await expect(storage.insertHeader(makeHeader(firstHeight + 1, 'e', 'ee'.repeat(32)))).resolves.toMatchObject({
      added: false,
      noPrev: true
    })
    await expect(storage.insertHeader(makeHeader(firstHeight + 2, 'f', first.hash))).resolves.toMatchObject({
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

    await storage.deleteLiveBlockHeaders()
  })
})

async function emptyStorage(storageClass: typeof ChaintracksStorageIdb = ChaintracksStorageIdb) {
  const options = ChaintracksStorageBase.createStorageBaseOptions('main')
  options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
  const storage = new storageClass(options)
  storage.dbName = `chaintracks-idb-security-${Date.now()}-${Math.random()}`
  await storage.migrateLatest()
  return storage
}

function storedHeader(height: number, hashByte: string, active: boolean, tip = false): LiveBlockHeader {
  return {
    headerId: 0,
    chainWork: '01'.repeat(32),
    isChainTip: tip,
    isActive: active,
    previousHeaderId: null,
    height,
    hash: hashByte.repeat(64),
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: hashByte.repeat(64),
    time: height,
    bits: 0x1d00ffff,
    nonce: height
  }
}

describe('ChaintracksStorageIdb security boundaries', () => {
  test('fails closed on empty, invalid, and non-canonical IndexedDB state', async () => {
    const storage = await emptyStorage(BehaviorChaintracksStorageIdb)
    try {
      await expect(storage.findChainTipHeader()).rejects.toThrow('no active chain tip')
      await expect(storage.findChainTipHeaderOrUndefined()).resolves.toBeUndefined()
      await expect(storage.findLiveHeightRange()).resolves.toEqual({ minHeight: 0, maxHeight: -1 })
      await expect(storage.findMaxHeaderId()).resolves.toBe(0)
      await expect(storage.findLiveHeaderForHeaderId(0)).rejects.toThrow('headerId')
      await expect(storage.findLiveHeaderForHeaderId(1)).resolves.toBeUndefined()
      await expect(storage.findLiveHeaderForHeight(Number.NaN)).rejects.toThrow('height')
      await expect(storage.findLiveHeaderForHeight(1)).resolves.toBeNull()
      await expect(storage.findLiveHeaderForMerkleRoot('bad')).rejects.toThrow('merkleRoot')
      await expect(storage.findLiveHeaderForMerkleRoot('00'.repeat(32))).resolves.toBeNull()
      await expect(storage.liveHeadersForBulk(0)).rejects.toThrow('count')
      await expect(storage.liveHeadersForBulk(100_001)).rejects.toThrow('count')

      const malformed = { ...storedHeader(7, 'a', true), isActive: 2 as never } as Record<string, unknown>
      delete malformed.headerId
      const trx = storage.db!.transaction('live_headers', 'readwrite')
      await trx.store.add(malformed as never)
      await trx.done
      await expect(storage.findLiveHeaderForBlockHash('a'.repeat(64))).rejects.toThrow('non-canonical')
    } finally {
      storage.db?.close()
    }
  })

  test('validates and owns IndexedDB bulk-file operations and slices', async () => {
    const storage = await emptyStorage(BehaviorChaintracksStorageIdb)
    const file = {
      chain: 'main',
      fileName: 'bounded.headers',
      firstHeight: 0,
      count: 1,
      prevChainWork: '00'.repeat(32),
      lastChainWork: '01'.repeat(32),
      prevHash: '00'.repeat(32),
      lastHash: '11'.repeat(32),
      fileHash: Buffer.alloc(32).toString('base64'),
      data: Uint8Array.from([1, 2, 3, 4])
    } as const
    try {
      const fileId = await storage.insertBulkFile(file)
      await expect(storage.getBulkFileData(fileId)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]))
      await expect(storage.getBulkFileData(fileId, 1, 2)).resolves.toEqual(Uint8Array.from([2, 3]))
      await expect(storage.getBulkFiles()).resolves.toMatchObject([
        { fileId, fileName: file.fileName, data: undefined }
      ])
      await expect(storage.updateBulkFile(fileId, { ...file, data: undefined })).resolves.toBe(1)
      await expect(storage.getBulkFileData(fileId)).resolves.toBeUndefined()
      await expect(storage.deleteBulkFile(fileId)).resolves.toBe(1)
      await expect(storage.deleteBulkFile(fileId)).resolves.toBe(0)
      await expect(storage.getBulkFileData(fileId)).rejects.toThrow('not found')

      await expect(storage.deleteBulkFile(0)).rejects.toThrow('fileId')
      await expect(storage.updateBulkFile(0, file)).rejects.toThrow('fileId')
      await expect(storage.updateBulkFile(1, { ...file, chain: 'test' })).rejects.toThrow('file.chain')
      await expect(storage.replaceBulkFiles([{ ...file, chain: 'test' }])).rejects.toThrow('file.chain')
      await expect(storage.getBulkFileData(1, Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow('safe integers')
    } finally {
      storage.db?.close()
    }
  })

  test('returns the unique active header rather than the first orphan at a height', async () => {
    const storage = await emptyStorage(BehaviorChaintracksStorageIdb)
    const orphan = storedHeader(7, 'a', false)
    const active = storedHeader(7, 'b', true)
    await storage.insertLiveHeader(orphan)
    await storage.insertLiveHeader(active)

    await expect(storage.findLiveHeaderForHeight(7)).resolves.toMatchObject({ hash: active.hash, isActive: true })

    const secondActive = storedHeader(7, 'c', true)
    await storage.insertLiveHeader(secondActive)
    await expect(storage.findLiveHeaderForHeight(7)).rejects.toThrow('multiple active headers')
  })

  test('disconnects every surviving child when pruning a shared ancestor', async () => {
    const storage = await emptyStorage(BehaviorChaintracksStorageIdb)
    const parent = await storage.insertLiveHeader(storedHeader(1, 'a', true))
    const firstChild = { ...storedHeader(2, 'b', true), previousHeaderId: parent.headerId }
    const secondChild = { ...storedHeader(2, 'c', false), previousHeaderId: parent.headerId }
    await storage.insertLiveHeader(firstChild)
    await storage.insertLiveHeader(secondChild)

    await expect(storage.deleteOlderLiveBlockHeaders(1)).resolves.toBe(1)
    await expect(storage.findLiveHeaderForBlockHash(firstChild.hash)).resolves.toMatchObject({ previousHeaderId: null })
    await expect(storage.findLiveHeaderForBlockHash(secondChild.hash)).resolves.toMatchObject({
      previousHeaderId: null
    })
  })

  test('authenticates direct inserts and rejects unsafe query and slice bounds', async () => {
    const storage = await emptyStorage()
    const genesis = deserializeBlockHeader(genesisBuffer('main'), 0)
    jest.spyOn(storage.bulkManager, 'getLastFile').mockResolvedValue({
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

    await expect(storage.insertHeader(genesis)).resolves.toMatchObject({ added: true })
    await expect(storage.insertHeader({ ...genesis, nonce: genesis.nonce + 1 })).rejects.toThrow(
      'Header hash is invalid'
    )
    await expect(storage.insertLiveHeader(storedHeader(7, 'a', true))).rejects.toThrow('Header hash is invalid')
    await expect(storage.getHeadersUint8Array(0, 100_001)).rejects.toThrow('count')
    await expect(storage.findLiveHeaderForBlockHash('bad')).rejects.toThrow('hash')
    await expect(storage.getBulkFileData(0)).rejects.toThrow('fileId')
    await expect(storage.getBulkFileData(1, 0)).rejects.toThrow('offset and length')
    await expect(storage.getBulkFileData(1, -1, 1)).rejects.toThrow('offset and length')
  })
})
