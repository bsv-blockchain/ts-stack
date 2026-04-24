import 'fake-indexeddb/auto'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { Chain } from '../../../../../sdk'
import { ChaintracksStorageKnex } from '../ChaintracksStorageKnex'
import { deserializeBaseBlockHeader, genesisHeader } from '../../util/blockHeaderUtilities'
import { ChaintracksStorageIdb, ChaintracksStorageIdbOptions } from '../ChaintracksStorageIdb'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { LiveBlockHeader } from '../../Api/BlockHeaderApi'

describe('ChaintracksStorageIdb tests', () => {
  jest.setTimeout(99999999)

  let logSpy: jest.SpyInstance,
    capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  test('0', async () => {
    const options: ChaintracksStorageIdbOptions = ChaintracksStorageBase.createStorageBaseOptions('main')
    const storage = new ChaintracksStorageIdb(options)
    const r = await storage.migrateLatest()
    const db = storage.db!
    expect(db).toBeTruthy()

    const tip = await storage.findChainTipHeaderOrUndefined()
    expect(tip).toBeUndefined()

    const ranges = await storage.getAvailableHeightRanges()

    const lh: LiveBlockHeader = {
      headerId: 0,
      chainWork: '00'.repeat(32),
      isChainTip: false,
      isActive: true,
      previousHeaderId: null,
      height: ranges.bulk.maxHeight + 1,
      hash: '1111',
      version: 0,
      previousHash: '01'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 0,
      bits: 0,
      nonce: 0
    }
    await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '2222'
    lh.merkleRoot = '22'.repeat(32)
    lh.height++
    await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '3333'
    lh.merkleRoot = '33'.repeat(32)
    lh.height++
    await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '4444'
    lh.height++
    await storage.insertLiveHeader(lh)
    lh.previousHeaderId = lh.headerId
    lh.hash = '5555'
    lh.height++
    lh.isChainTip = true
    await storage.insertLiveHeader(lh)

    const h1 = await storage.findLiveHeaderForBlockHash('1111')
    expect(h1!.headerId).toBe(1)

    const h2 = await storage.findLiveHeaderForMerkleRoot('22'.repeat(32))
    expect(h2!.headerId).toBe(2)

    const h3 = await storage.findLiveHeaderForHeaderId(3)
    expect(h3!.headerId).toBe(3)

    const h4 = await storage.findLiveHeaderForHeight(4 + ranges.bulk.maxHeight)
    expect(h4!.headerId).toBe(4)

    const h5 = await storage.findChainTipHeader()
    expect(h5.headerId).toBe(5)

    const range = await storage.findLiveHeightRange()
    expect(range).toEqual({ minHeight: 1 + ranges.bulk.maxHeight, maxHeight: 5 + ranges.bulk.maxHeight })

    const maxId = await storage.findMaxHeaderId()
    expect(maxId).toBe(5)

    const hfbs = await storage.liveHeadersForBulk(3)
    expect(hfbs.length).toBe(3)

    const lhs = await storage.getHeaders(0, 10)
    expect(lhs.length).toBe(10)

    const lhs2 = await storage.getHeaders(0 + ranges.bulk.maxHeight + 1, 10)
    expect(lhs2.length).toBe(5)

    const lhs3 = await storage.getHeaders(0 + ranges.bulk.maxHeight - 2, 10)
    expect(lhs3.length).toBe(8)

    const data = await storage.getHeadersUint8Array(0, 10)
    expect(data.length).toBe(10 * 80)

    const deleteCount = await storage.deleteOlderLiveBlockHeaders(3 + ranges.bulk.maxHeight)
    expect(deleteCount).toBe(3)

    await storage.deleteLiveBlockHeaders()
  })
})
