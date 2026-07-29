import { Knex, knex as makeKnex } from 'knex'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { Chain } from '../../../../../sdk'
import { ChaintracksStorageKnex } from '../ChaintracksStorageKnex'
import { deserializeBaseBlockHeader, genesisHeader } from '../../util/blockHeaderUtilities'
import { BlockHeader } from '../../Api/BlockHeaderApi'

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
    if (bfs?.length === 0) return

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

  test('insertHeader preserves linear, duplicate, invalid-parent, and reorg behavior', async () => {
    const knexInstance = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    const storage = new ChaintracksStorageKnex(ChaintracksStorageKnex.createStorageKnexOptions('main', knexInstance))
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
})
