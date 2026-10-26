import { BlockHeader } from '../../Api/BlockHeaderApi'
import { LiveIngestorWhatsOnChainPoll } from '../LiveIngestorWhatsOnChainPoll'
import { WocGetHeadersHeader } from '../WhatsOnChainServices'
import { ChaintracksFetchError } from '../../util/ChaintracksFetch'
import { genesisHeader } from '../../util/blockHeaderUtilities'
import { Chain } from '../../../../../sdk'

describe('LiveIngestorWhatsOnChainPoll tests', () => {
  jest.setTimeout(99999999)

  let logSpy: jest.SpyInstance
  const capturedLogs: string[] = []
  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
  })

  afterAll(() => {
    logSpy.mockRestore()
  })

  test('retries transient getHeaders failures without rejecting', async () => {
    const liveHeaders: BlockHeader[] = []
    const options = LiveIngestorWhatsOnChainPoll.createLiveIngestorWhatsOnChainOptions('main')
    options.retryWait = 1
    options.retryWaitMax = 1
    const ingestor = new LiveIngestorWhatsOnChainPoll(options)
    ingestor.log = (...args: any[]) => capturedLogs.push(args.map(String).join(' '))
    const header = mockWocHeader()
    const getHeaders = jest
      .fn()
      .mockRejectedValueOnce(
        new ChaintracksFetchError('rate limited', 'https://woc.example/headers', 429, 'Too Many Requests', 1)
      )
      .mockImplementationOnce(async () => {
        ingestor.stopListening()
        return [header]
      })
    ingestor.woc = { getHeaders } as unknown as typeof ingestor.woc

    await ingestor.startListening(liveHeaders)

    expect(getHeaders).toHaveBeenCalledTimes(2)
    expect(liveHeaders).toHaveLength(1)
    expect(liveHeaders[0].hash).toBe(header.hash)
    expect(capturedLogs.some(l => l.includes('getHeaders failed') && l.includes('429'))).toBe(true)
  })

  test('bounds the live header queue and drops excess validated headers', async () => {
    const liveHeaders: BlockHeader[] = [{ ...genesisHeader('main') }]
    const options = LiveIngestorWhatsOnChainPoll.createLiveIngestorWhatsOnChainOptions('main')
    options.maxQueuedHeaders = 1
    const ingestor = new LiveIngestorWhatsOnChainPoll(options)
    const logs: string[] = []
    ingestor.log = message => logs.push(String(message))
    const incoming = mockWocHeader('test')
    ingestor.woc = {
      getHeaders: async () => {
        ingestor.stopListening()
        return [incoming]
      }
    } as unknown as typeof ingestor.woc

    await ingestor.startListening(liveHeaders)

    expect(liveHeaders).toHaveLength(1)
    expect(liveHeaders[0].hash).toBe(genesisHeader('main').hash)
    expect(logs.some(log => log.includes('queue capacity 1 reached'))).toBe(true)
  })

  test('accepts the first locally simulated valid header and stops cleanly', async () => {
    const liveHeaders: BlockHeader[] = []
    const options = LiveIngestorWhatsOnChainPoll.createLiveIngestorWhatsOnChainOptions('main')
    options.idleWait = 1
    const ingestor = new LiveIngestorWhatsOnChainPoll(options)
    const header = mockWocHeader()
    ingestor.woc = {
      getHeaders: async () => {
        ingestor.stopListening()
        return [header]
      }
    } as unknown as typeof ingestor.woc

    await ingestor.startListening(liveHeaders)

    expect(liveHeaders).toHaveLength(1)
    expect(liveHeaders[0].hash).toBe(header.hash)
  })
})

function mockWocHeader(chain: Chain = 'main'): WocGetHeadersHeader {
  const header = genesisHeader(chain)
  return {
    hash: header.hash,
    confirmations: 1,
    size: 1,
    height: header.height,
    version: header.version,
    versionHex: header.version.toString(16).padStart(8, '0'),
    merkleroot: header.merkleRoot,
    time: header.time,
    mediantime: header.time,
    nonce: header.nonce,
    bits: header.bits.toString(16).padStart(8, '0'),
    difficulty: 1,
    chainwork: '00'.repeat(32),
    previousblockhash: header.previousHash,
    nextblockhash: '',
    nTx: 1,
    num_tx: 1
  }
}
