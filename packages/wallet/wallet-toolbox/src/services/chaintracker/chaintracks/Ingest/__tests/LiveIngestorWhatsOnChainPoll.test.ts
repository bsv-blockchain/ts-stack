import { wait } from '../../../../../utility/utilityHelpers'
import { BlockHeader } from '../../Api/BlockHeaderApi'
import { LiveIngestorWhatsOnChainPoll } from '../LiveIngestorWhatsOnChainPoll'
import { WocGetHeadersHeader } from '../WhatsOnChainServices'
import { ChaintracksFetchError } from '../../util/ChaintracksFetch'

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
    const getHeaders = jest.fn()
      .mockRejectedValueOnce(new ChaintracksFetchError('rate limited', 'https://woc.example/headers', 429, 'Too Many Requests', 1))
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

  test('0 listen for first new header', async () => {
    const liveHeaders: BlockHeader[] = []
    const options = LiveIngestorWhatsOnChainPoll.createLiveIngestorWhatsOnChainOptions('main')
    const ingestor = new LiveIngestorWhatsOnChainPoll(options)
    const p = ingestor.startListening(liveHeaders)
    let log = ''
    let count = 0
    for (;;) {
      const h = liveHeaders.shift()
      if (h != null) {
        log += `${h.height} ${h.hash}\n`
        count++
      } else {
        if (log) {
          console.log(`LiveIngestorWhatsOnChain received ${count} headers:\n${log}`)
          log = ''
          break
        }
        // if (count >= 11) break
        await wait(100)
      }
    }
    ingestor.stopListening()
    await p
    expect(count).toBeGreaterThan(0)
  })
})

function mockWocHeader (): WocGetHeadersHeader {
  return {
    hash: '11'.repeat(32),
    confirmations: 1,
    size: 1,
    height: 123,
    version: 1,
    versionHex: '00000001',
    merkleroot: '22'.repeat(32),
    time: 1,
    mediantime: 1,
    nonce: 1,
    bits: '1d00ffff',
    difficulty: 1,
    chainwork: '00',
    previousblockhash: '33'.repeat(32),
    nextblockhash: '',
    nTx: 1,
    num_tx: 1
  }
}
