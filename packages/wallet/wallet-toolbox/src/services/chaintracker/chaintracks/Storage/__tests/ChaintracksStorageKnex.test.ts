import { Knex, knex as makeKnex } from 'knex'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { Chain } from '../../../../../sdk'
import { ChaintracksStorageKnex } from '../ChaintracksStorageKnex'
import {
  deserializeBaseBlockHeader,
  deserializeBlockHeader,
  genesisBuffer,
  genesisHeader
} from '../../util/blockHeaderUtilities'
import { BlockHeader } from '../../Api/BlockHeaderApi'
import { BulkFileDataManager } from '../../util/BulkFileDataManager'
import { createChaintracksInitialSchema } from '../ChaintracksKnexMigrations'
import { HeightRange } from '../../util/HeightRange'

class BehaviorChaintracksStorageKnex extends ChaintracksStorageKnex {
  protected override validateIncomingHeader(header: BlockHeader): BlockHeader {
    return { ...header }
  }
}

describe('ChaintracksStorageKnex tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const chain: Chain = 'main'
    const fs = ChaintracksFs
    const rootFolder = './src/services/chaintracker/chaintracks/__tests/data'
    const localSqlite: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: fs.pathJoin(rootFolder, `${chain}Net_chaintracks.sqlite`) },
      useNullAsDefault: true
    }

    const knexInstance = makeKnex(localSqlite)

    const knexOptions = ChaintracksStorageKnex.createStorageKnexOptions(chain)
    knexOptions.knex = knexInstance
    const storage = new ChaintracksStorageKnex(knexOptions)
    await storage.makeAvailable()

    const bfs = await storage.bulkManager.getBulkFiles()
    // Test assumes synchronization has occurred and bulk files are available.
    if (bfs?.length === 0) {
      await storage.shutdown()
      return
    }

    expect(bfs.length).toBeGreaterThan(7)

    const gh = await storage.getBulkFileData(bfs[0].fileId!, 0, 80)
    const dgh = deserializeBaseBlockHeader(gh!)
    const rgh = genesisHeader(chain)
    expect(dgh.merkleRoot).toEqual(rgh.merkleRoot)
    expect(dgh.bits).toEqual(rgh.bits)
    expect(dgh.nonce).toEqual(rgh.nonce)

    const header = await storage.findHeaderForHeight(101010)
    expect(header.hash).toEqual('000000000001af33247fff33aae7c31baee4148d5a189e7353bf13bcee618202')

    await storage.shutdown()
  })

  test('getBulkFileData binds slice values and rejects unsafe bounds', async () => {
    const knexInstance = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const options = ChaintracksStorageKnex.createStorageKnexOptions('main', knexInstance)
    options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const storage = new ChaintracksStorageKnex(options)
    await storage.makeAvailable()
    try {
      const file = {
        chain: 'main',
        fileName: 'slice-test.headers',
        firstHeight: 0,
        count: 1,
        prevChainWork: '00'.repeat(32),
        lastChainWork: '01'.repeat(32),
        prevHash: '00'.repeat(32),
        lastHash: '11'.repeat(32),
        fileHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        data: Buffer.from([1, 2, 3, 4])
      } as const
      const fileId = await storage.insertBulkFile(file)

      expect(file).not.toHaveProperty('fileId')
      await expect(storage.getBulkFileData(fileId, 1, 2)).resolves.toEqual(Uint8Array.from([2, 3]))
      await expect(
        storage.replaceBulkFiles([{ ...file, fileId, fileName: 'preserved.headers', data: undefined }])
      ).resolves.toMatchObject([{ fileId, fileName: 'preserved.headers' }])
      await expect(storage.getBulkFileData(fileId)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]))

      await expect(
        storage.replaceBulkFiles([
          { ...file, fileId, fileName: 'must-rollback.headers', data: undefined },
          {
            ...file,
            fileId: fileId + 999,
            fileName: 'missing-id.headers',
            fileHash: Buffer.alloc(32, 2).toString('base64'),
            firstHeight: 1,
            prevHash: file.lastHash,
            prevChainWork: file.lastChainWork,
            lastHash: '22'.repeat(32),
            lastChainWork: '02'.repeat(32)
          }
        ])
      ).rejects.toThrow('current bulk-file set')
      await expect(storage.getBulkFiles()).resolves.toMatchObject([{ fileId, fileName: 'preserved.headers' }])
      await expect(storage.getBulkFileData(fileId, -1, 2)).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
      await expect(storage.getBulkFileData(fileId, 1)).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
      await expect(storage.getBulkFileData(0, 0, 1)).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
      await expect(storage.getBulkFileData(fileId + 1)).resolves.toBeUndefined()
      await expect(storage.insertBulkFile({ ...file, fileName: '../outside.headers' })).rejects.toThrow('path-free')
      await expect(storage.updateBulkFile(fileId, { ...file, fileId: fileId + 1 })).rejects.toThrow('file.fileId')
    } finally {
      await storage.shutdown()
    }
  })

  test('uses non-truncating MySQL columns for hex identifiers and large bulk data', async () => {
    const mysql = makeKnex({ client: 'mysql2' })
    try {
      const ddl = createChaintracksInitialSchema(mysql)
        .toSQL()
        .map(statement => statement.sql)
        .join('\n')
      expect(ddl).toContain('`hash` varchar(64) not null')
      expect(ddl).toContain('`chainWork` varchar(64) not null')
      expect(ddl).toContain('`merkleRoot` varchar(64) not null')
      expect(ddl).toContain('`data` LONGBLOB null')
      expect(ddl).toContain('create table `chaintracks_state`')
      expect(ddl).not.toContain('varbinary(32)')
      expect(ddl).not.toContain('varbinary(32000000)')
    } finally {
      await mysql.destroy()
    }
  })

  test('insertHeader preserves linear, duplicate, invalid-parent, and reorg behavior', async () => {
    const knexInstance = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const options = ChaintracksStorageKnex.createStorageKnexOptions('main', knexInstance)
    options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const storage = new BehaviorChaintracksStorageKnex(options)
    await storage.makeAvailable()
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

    await storage.shutdown()
  })

  test('authenticates direct inserts and preserves a genesis-only live range', async () => {
    const knexInstance = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const options = ChaintracksStorageKnex.createStorageKnexOptions('main', knexInstance)
    options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const storage = new ChaintracksStorageKnex(options)
    await storage.makeAvailable()
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

    try {
      await expect(storage.insertHeader(genesis)).resolves.toMatchObject({ added: true })
      await expect(storage.findLiveHeightRange()).resolves.toEqual({ minHeight: 0, maxHeight: 0 })
      await expect(storage.findMaxHeaderId()).resolves.toBe(1)
      await expect(storage.insertHeader({ ...genesis, hash: 'ff'.repeat(32) })).rejects.toThrow(
        'Header hash is invalid'
      )
      await expect(storage.findLiveHeaderForHeight(-1)).rejects.toThrow('height')
      await expect(storage.findLiveHeaderForBlockHash('bad')).rejects.toThrow('hash')
    } finally {
      await storage.shutdown()
    }
  })

  test('fails closed on unavailable, empty, corrupt, and out-of-range database state', async () => {
    const absent = ChaintracksStorageKnex.createStorageKnexOptions('main')
    expect(() => new ChaintracksStorageKnex(absent)).toThrow('knex options property is required')

    const knexInstance = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const options = ChaintracksStorageKnex.createStorageKnexOptions('main', knexInstance)
    options.bulkFileDataManager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const storage = new ChaintracksStorageKnex(options)
    expect(() => storage.dbtype).toThrow('makeAvailable first')
    await storage.makeAvailable()
    try {
      await expect(storage.findLiveHeightRange()).resolves.toEqual(HeightRange.empty)
      await expect(storage.findMaxHeaderId()).resolves.toBe(-1)
      await expect(storage.findChainTipHeader()).rejects.toThrow('no active chain tip')
      await expect(storage.findChainTipHeaderOrUndefined()).resolves.toBeUndefined()
      await expect(storage.findLiveHeaderForHeaderId(0)).rejects.toThrow('headerId')
      await expect(storage.findLiveHeaderForHeaderId(1)).rejects.toThrow('not found')
      await expect(storage.findLiveHeaderForHeight(Number.NaN)).rejects.toThrow('height')
      await expect(storage.findLiveHeaderForHeight(1)).resolves.toBeNull()
      await expect(storage.findLiveHeaderForBlockHash('bad')).rejects.toThrow('hash')
      await expect(storage.findLiveHeaderForBlockHash('00'.repeat(32))).resolves.toBeNull()
      await expect(storage.findLiveHeaderForMerkleRoot('bad')).rejects.toThrow('merkleRoot')
      await expect(storage.findLiveHeaderForMerkleRoot('00'.repeat(32))).resolves.toBeNull()
      await expect(storage.getLiveHeaders(HeightRange.empty)).resolves.toEqual([])
      await expect(storage.liveHeadersForBulk(0)).rejects.toThrow('count')
      await expect(storage.liveHeadersForBulk(100_001)).rejects.toThrow('count')
      await expect(storage.deleteBulkFile(0)).rejects.toThrow('fileId')
      await expect(storage.updateBulkFile(0, {} as never)).rejects.toThrow('fileId')
      await expect(storage.getBulkFileData(1, Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow('safe integers')

      const wrongChain = {
        chain: 'test',
        fileName: 'wrong-chain.headers',
        firstHeight: 0,
        count: 1,
        prevChainWork: '00'.repeat(32),
        lastChainWork: '01'.repeat(32),
        prevHash: '00'.repeat(32),
        lastHash: '11'.repeat(32),
        fileHash: Buffer.alloc(32).toString('base64')
      } as const
      await expect(storage.insertBulkFile(wrongChain)).rejects.toThrow('file.chain')
      await expect(storage.replaceBulkFiles([wrongChain])).rejects.toThrow('file.chain')

      const row = (id: number, height = 1) => ({
        headerId: id,
        previousHeaderId: null,
        previousHash: '00'.repeat(32),
        height,
        isActive: true,
        isChainTip: true,
        hash: id.toString(16).padStart(64, '0'),
        chainWork: '00'.repeat(32),
        version: 1,
        merkleRoot: id.toString(16).padStart(64, '0'),
        time: 1,
        bits: 0x1d00ffff,
        nonce: 1
      })
      await knexInstance(storage.headerTableName).insert([row(1), row(2)])
      await expect(storage.findChainTipHeader()).rejects.toThrow('multiple active chain tips')
      await expect(storage.findChainTipHeaderOrUndefined()).rejects.toThrow('multiple active chain tips')
      await expect(storage.findLiveHeaderForHeight(1)).rejects.toThrow('multiple active headers')
    } finally {
      await storage.shutdown()
    }
  })
})
