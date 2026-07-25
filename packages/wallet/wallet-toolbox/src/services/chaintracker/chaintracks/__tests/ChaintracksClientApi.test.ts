import { Chain } from '../../../../sdk/types'
import { BaseBlockHeader, BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { asString, asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import {
  ChaintracksClientApi,
  ChaintracksInfoApi,
  HeaderListener,
  ReorgListener
} from '../Api/ChaintracksClientApi'
import { Chaintracks } from '../Chaintracks'
import { ChaintracksService } from '../ChaintracksService'
import { ChaintracksServiceClient } from '../ChaintracksServiceClient'
import {
  blockHash,
  deserializeBaseBlockHeaders,
  genesisBuffer,
  genesisHeader,
  serializeBaseBlockHeader,
  serializeBaseBlockHeaders
} from '../util/blockHeaderUtilities'

const chain: Chain = 'main'
const fixtureHeaders = createFixtureHeaders()

describe('ChaintracksClientApi deterministic contract', () => {
  const clients: Array<{ client: ChaintracksClientApi, chain: Chain }> = []
  let localService: ChaintracksService
  let fixtureChaintracks: FixtureChaintracks
  let firstTip: BlockHeader
  let logSpy: jest.SpyInstance

  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    fixtureChaintracks = new FixtureChaintracks(chain, fixtureHeaders)
    localService = new ChaintracksService({
      ...ChaintracksService.createChaintracksServiceOptions(chain),
      chaintracks: fixtureChaintracks as unknown as Chaintracks
    })

    // Each Jest worker has a separate process ID, avoiding collisions when
    // package tests execute in parallel.
    await localService.startJsonRpcServer(30000 + (process.pid % 10000))
    const localServiceClient = new ChaintracksServiceClient(
      chain,
      `http://localhost:${localService.port}`,
      {}
    )

    clients.push(
      { client: localServiceClient, chain },
      { client: fixtureChaintracks, chain }
    )
    firstTip = await clients[0].client.findChainTipHeader()
  })

  afterAll(async () => {
    await localService?.stopJsonRpcServer()
    logSpy?.mockRestore()
  })

  test('reports its chain', async () => {
    for (const { client, chain } of clients) {
      await expect(client.getChain()).resolves.toBe(chain)
    }
  })

  test('reports deterministic bulk and live ranges', async () => {
    for (const { client, chain } of clients) {
      const gotInfo = await client.getInfo()
      expect(gotInfo).toMatchObject({
        chain,
        heightBulk: 800001,
        heightLive: 800003
      })
    }
  })

  test('reports present and current height', async () => {
    for (const { client } of clients) {
      await expect(client.getPresentHeight()).resolves.toBe(firstTip.height)
      await expect(client.currentHeight()).resolves.toBe(firstTip.height)
    }
  })

  test('returns linked headers across bulk and live ranges', async () => {
    for (const { client } of clients) {
      const info = await client.getInfo()
      const firstLiveHeight = info.heightBulk + 1
      const cases = [
        { height: firstLiveHeight - 2, count: 2, expected: 2 },
        { height: firstLiveHeight - 1, count: 2, expected: 2 },
        { height: firstLiveHeight, count: 2, expected: 2 },
        { height: info.heightLive, count: 2, expected: 1 }
      ]

      for (const { height, count, expected } of cases) {
        const headers = deserializeBaseBlockHeaders(asUint8Array(await client.getHeaders(height, count)))
        expect(headers).toHaveLength(expected)
        if (headers.length === 2) {
          expect(headers[1].previousHash).toBe(blockHash(headers[0]))
        }
      }
    }
  })

  test('finds the chain tip header and hash', async () => {
    for (const { client } of clients) {
      await expect(client.findChainTipHeader()).resolves.toEqual(firstTip)
      await expect(client.findChainTipHash()).resolves.toBe(firstTip.hash)
    }
  })

  test('finds headers by height and returns undefined for a missing height', async () => {
    for (const { client, chain } of clients) {
      const header0 = await client.findHeaderForHeight(0)
      expect(header0).toBeDefined()
      expect(genesisBuffer(chain)).toEqual(serializeBaseBlockHeader(header0!))

      await expect(client.findHeaderForHeight(firstTip.height)).resolves.toEqual(firstTip)
      await expect(client.findHeaderForHeight(99999999)).resolves.toBeUndefined()
    }
  })

  test('finds headers by hash and returns undefined for a missing hash', async () => {
    for (const { client } of clients) {
      await expect(client.findHeaderForBlockHash(firstTip.hash)).resolves.toEqual(firstTip)
      await expect(client.findHeaderForBlockHash('ff'.repeat(32))).resolves.toBeUndefined()
    }
  })

  test('validates merkle roots at a height', async () => {
    for (const { client } of clients) {
      await expect(client.isValidRootForHeight(firstTip.merkleRoot, firstTip.height)).resolves.toBe(true)
      await expect(client.isValidRootForHeight('ff'.repeat(32), firstTip.height)).resolves.toBe(false)
    }
  })

  test('reports listening and synchronization state', async () => {
    for (const { client } of clients) {
      await expect(client.startListening()).resolves.toBeUndefined()
      await expect(client.listening()).resolves.toBeUndefined()
      await expect(client.isListening()).resolves.toBe(true)
      await expect(client.isSynchronized()).resolves.toBe(true)
    }
  })

  test('accepts a submitted header', async () => {
    const header: BaseBlockHeader = {
      version: firstTip.version,
      previousHash: firstTip.hash,
      merkleRoot: 'ee'.repeat(32),
      time: firstTip.time + 1,
      bits: firstTip.bits,
      nonce: firstTip.nonce + 1
    }

    for (const { client } of clients) {
      await expect(client.addHeader(header)).resolves.toBeUndefined()
    }
  })
})

class FixtureChaintracks implements ChaintracksClientApi {
  readonly byHeight = new Map<number, BlockHeader>()
  readonly byHash = new Map<string, BlockHeader>()
  readonly tip: BlockHeader
  readonly submittedHeaders: BaseBlockHeader[] = []

  constructor (
    public readonly chain: Chain,
    headers: BlockHeader[]
  ) {
    for (const header of headers) {
      this.byHeight.set(header.height, header)
      this.byHash.set(header.hash, header)
    }
    this.tip = headers.at(-1)!
  }

  async makeAvailable (): Promise<void> {}
  async destroy (): Promise<void> {}
  async getChain (): Promise<Chain> { return this.chain }

  async getInfo (): Promise<ChaintracksInfoApi> {
    return {
      chain: this.chain,
      heightBulk: 800001,
      heightLive: this.tip.height,
      storage: 'FixtureChaintracks',
      bulkIngestors: ['FixtureBulkIngestor'],
      liveIngestors: ['FixtureLiveIngestor'],
      packages: []
    }
  }

  async getPresentHeight (): Promise<number> { return this.tip.height }
  async currentHeight (): Promise<number> { return this.tip.height }

  async getHeaders (height: number, count: number): Promise<string> {
    const headers: BlockHeader[] = []
    for (let current = height; current < height + count; current++) {
      const header = this.byHeight.get(current)
      if (header == null) break
      headers.push(header)
    }
    return asString(serializeBaseBlockHeaders(headers))
  }

  async findChainTipHeader (): Promise<BlockHeader> { return this.tip }
  async findChainTipHash (): Promise<string> { return this.tip.hash }
  async findHeaderForHeight (height: number): Promise<BlockHeader | undefined> { return this.byHeight.get(height) }
  async findHeaderForBlockHash (hash: string): Promise<BlockHeader | undefined> { return this.byHash.get(hash) }
  async findLiveHeaderForBlockHash (hash: string): Promise<BlockHeader | undefined> { return this.byHash.get(hash) }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    return this.byHeight.get(height)?.merkleRoot === root
  }

  async addHeader (header: BaseBlockHeader): Promise<void> {
    this.submittedHeaders.push(header)
  }

  async startListening (): Promise<void> {}
  async listening (): Promise<void> {}
  async isListening (): Promise<boolean> { return true }
  async isSynchronized (): Promise<boolean> { return true }
  async subscribeHeaders (_listener: HeaderListener): Promise<string> { return 'fixture-header-subscription' }
  async subscribeReorgs (_listener: ReorgListener): Promise<string> { return 'fixture-reorg-subscription' }
  async unsubscribe (_subscriptionId: string): Promise<boolean> { return true }
}

function createFixtureHeaders (): BlockHeader[] {
  const headers: BlockHeader[] = [genesisHeader(chain)]
  let previousHash = '11'.repeat(32)

  for (let height = 800000; height <= 800003; height++) {
    const base: BaseBlockHeader = {
      version: 1,
      previousHash,
      merkleRoot: height.toString(16).padStart(64, '0'),
      time: 1700000000 + height,
      bits: 486604799,
      nonce: height
    }
    const header: BlockHeader = {
      ...base,
      height,
      hash: blockHash(base)
    }
    headers.push(header)
    previousHash = header.hash
  }

  return headers
}
