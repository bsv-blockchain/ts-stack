import { BlockHeader } from '../../Api/BlockHeaderApi'
import { ChaintracksStorageBase } from '../ChaintracksStorageBase'
import { ChaintracksStorageNoDb } from '../ChaintracksStorageNoDb'

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
    storage = new ChaintracksStorageNoDb(ChaintracksStorageBase.createStorageBaseOptions('main'))
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
})
