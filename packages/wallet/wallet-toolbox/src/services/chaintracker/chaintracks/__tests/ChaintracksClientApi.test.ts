import { Chain } from '../../../../sdk/types'
import { BaseBlockHeader, BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { asString, asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { ChaintracksClientApi } from '../Api/ChaintracksClientApi'
import { Chaintracks } from '../Chaintracks'
import { ChaintracksService } from '../ChaintracksService'
import { ChaintracksServiceClient } from '../ChaintracksServiceClient'
import { createDefaultNoDbChaintracksOptions } from '../createDefaultNoDbChaintracksOptions'
import { BulkIngestorWhatsOnChainCdn } from '../Ingest/BulkIngestorWhatsOnChainCdn'
import { LiveIngestorWhatsOnChainPoll } from '../Ingest/LiveIngestorWhatsOnChainPoll'
import { WhatsOnChainServices, WocGetHeadersHeader } from '../Ingest/WhatsOnChainServices'
import { BulkHeaderFilesInfo } from '../util/BulkHeaderFile'
import { ChaintracksFs } from '../util/ChaintracksFs'
import {
  blockHash,
  deserializeBaseBlockHeaders,
  deserializeBlockHeaders,
  genesisBuffer,
  serializeBaseBlockHeader
} from '../util/blockHeaderUtilities'

const chain: Chain = 'main'
const fixtureRoot = './src/services/chaintracker/chaintracks/__tests/data/cdnTest499'
const fixtureCdnUrl = 'https://fixture.invalid/blockheaders/'

describe('ChaintracksClientApi deterministic contract', () => {
  const clients: Array<{ client: ChaintracksClientApi, chain: Chain }> = []
  let localService: ChaintracksService
  let localChaintracks: Chaintracks
  let firstTip: BlockHeader
  let logSpy: jest.SpyInstance

  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const { filesInfo, fileData, headers } = await loadFixtureChain()
    const fixtureFetch = new FixtureFetch(filesInfo, fileData)
    const options = createDefaultNoDbChaintracksOptions(
      chain,
      '',
      100,
      10,
      fixtureFetch as unknown as ChaintracksFetchApi,
      fixtureCdnUrl,
      2,
      2,
      100,
      100,
      36
    )
    options.logging = () => {}

    const bulkWoc = options.bulkIngestors.find(
      ingestor => ingestor instanceof BulkIngestorWhatsOnChainCdn
    ) as BulkIngestorWhatsOnChainCdn
    WhatsOnChainServices.chainInfo[chain] = undefined
    WhatsOnChainServices.chainInfoTime[chain] = undefined
    bulkWoc.woc.woc.getChainInfo = async () => ({
      chain,
      blocks: headers.at(-1)!.height,
      headers: headers.at(-1)!.height,
      bestblockhash: headers.at(-1)!.hash,
      difficulty: 1,
      mediantime: headers.at(-1)!.time,
      verificationprogress: 1,
      pruned: false,
      chainwork: ''
    })

    const liveWoc = options.liveIngestors[0] as LiveIngestorWhatsOnChainPoll
    const headersByHash = new Map(headers.map(header => [header.hash, header]))
    liveWoc.woc.getHeaders = async () => headers.slice(-2).map(toWocHeader)
    liveWoc.woc.getHeaderByHash = async hash => headersByHash.get(hash)

    localChaintracks = new Chaintracks(options)
    localService = new ChaintracksService({
      ...ChaintracksService.createChaintracksServiceOptions(chain),
      chaintracks: localChaintracks
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
      { client: localChaintracks, chain }
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
        heightBulk: 497,
        heightLive: 499
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

  test('validates the deterministic chain from tip to genesis', async () => {
    await expect(localChaintracks.validate()).resolves.toBe(true)
  })

  test('manages direct header and reorganization subscriptions', async () => {
    const headerSubscription = await localChaintracks.subscribeHeaders(() => {})
    const reorgSubscription = await localChaintracks.subscribeReorgs(() => {})

    await expect(localChaintracks.unsubscribe(headerSubscription)).resolves.toBe(true)
    await expect(localChaintracks.unsubscribe(reorgSubscription)).resolves.toBe(true)
    await expect(localChaintracks.unsubscribe('missing-subscription')).resolves.toBe(false)
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

class FixtureFetch {
  constructor (
    private readonly filesInfo: BulkHeaderFilesInfo,
    private readonly fileData: Map<string, Uint8Array>
  ) {}

  async fetchJson<R> (url: string): Promise<R> {
    if (url.endsWith('mainNetBlockHeaders.json')) {
      return {
        ...this.filesInfo,
        files: this.filesInfo.files.slice(0, 4).map(file => ({ ...file }))
      } as R
    }
    if (url.endsWith('/block/headers/resources')) {
      return {
        files: [`${fixtureCdnUrl}400_499_headers`]
      } as R
    }
    throw new Error(`Unexpected fixture JSON request: ${url}`)
  }

  async download (url: string): Promise<Uint8Array> {
    const requestedName = url.split('/').at(-1)!
    const fileName = requestedName === '400_499_headers' ? 'mainNet_4.headers' : requestedName
    const data = this.fileData.get(fileName)
    if (data == null) throw new Error(`Unexpected fixture download request: ${url}`)
    return data
  }

  pathJoin (baseUrl: string, subpath: string): string {
    let baseEnd = baseUrl.length
    while (baseEnd > 0 && baseUrl[baseEnd - 1] === '/') baseEnd--

    let subpathStart = 0
    while (subpathStart < subpath.length && subpath[subpathStart] === '/') subpathStart++

    return `${baseUrl.slice(0, baseEnd)}/${subpath.slice(subpathStart)}`
  }
}

async function loadFixtureChain (): Promise<{
  filesInfo: BulkHeaderFilesInfo
  fileData: Map<string, Uint8Array>
  headers: BlockHeader[]
}> {
  const infoData = await ChaintracksFs.readFile(`${fixtureRoot}/mainNetBlockHeaders.json`)
  const filesInfo = JSON.parse(asString(infoData, 'utf8')) as BulkHeaderFilesInfo
  const fileData = new Map<string, Uint8Array>()
  const headers: BlockHeader[] = []

  for (const file of filesInfo.files) {
    const data = await ChaintracksFs.readFile(`${fixtureRoot}/${file.fileName}`)
    fileData.set(file.fileName, data)
    headers.push(...deserializeBlockHeaders(file.firstHeight, data))
  }

  return { filesInfo, fileData, headers }
}

function toWocHeader (header: BlockHeader): WocGetHeadersHeader {
  return {
    hash: header.hash,
    confirmations: 1,
    size: 80,
    height: header.height,
    version: header.version,
    versionHex: header.version.toString(16),
    merkleroot: header.merkleRoot,
    time: header.time,
    mediantime: header.time,
    nonce: header.nonce,
    bits: header.bits.toString(16),
    difficulty: 1,
    chainwork: '',
    previousblockhash: header.previousHash,
    nextblockhash: '',
    nTx: 0,
    num_tx: 0
  }
}
