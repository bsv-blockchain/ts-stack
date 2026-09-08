import { ChaintracksChainTracker } from '../index.all'
import { ChaintracksServiceClient } from '../chaintracks/ChaintracksServiceClient'
import { sdk } from '../../../index.client'
import { BlockHeader } from '../../../sdk/WalletServices.interfaces'

const includeTestChaintracks = false

// Fixtures captured from a healthy chaintracks endpoint
// (e.g. https://chaintracks-us-1.bsvb.tech). Mock fetch to keep the test offline.
const HEADER_877599 = {
  version: 570425344,
  previousHash: '00000000000000000a71b1ecfe047c69ca1817156a64c0cb8e40104e9c4af68a',
  merkleRoot: '2bf2edb5fa42aa773c6c13bc90e097b4e7de7ca1df2227f433be75ceace339e9',
  time: 1735682483,
  bits: 403553918,
  nonce: 2672581460,
  height: 877599,
  hash: '000000000000000001f67f9c4c4babc21d396fc15f70a6ca6fc70c6bcb17d90e'
}

const realFetch = global.fetch
beforeAll(() => {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (url.includes('chaintracks.babbage.systems/getPresentHeight')) {
      return jsonResponse({ status: 'success', value: 950000 })
    }
    if (url.includes('chaintracks.babbage.systems/findHeaderHexForHeight')) {
      const height = Number(new URL(url).searchParams.get('height'))
      if (height === 877599) {
        return jsonResponse({ status: 'success', value: HEADER_877599 })
      }
      return jsonResponse({ status: 'success' })
    }
    return realFetch(input, init)
  }) as any
})
afterAll(() => {
  global.fetch = realFetch
})

describe('ChaintracksChaintracker tests', () => {
  jest.setTimeout(99999999)

  test('0 test', async () => {
    if (!includeTestChaintracks) return
    await testChaintracksChaintracker('test')
  })

  test('1 main', async () => {
    await testChaintracksChaintracker('main')
  })

  test('retries transient header lookup failures', async () => {
    const chaintracks = makeChaintracksClient([new Error('temporary chaintracks failure'), undefined, HEADER_877599])
    const tracker = new ChaintracksChainTracker('main', chaintracks, { maxRetries: 3, retryDelayMs: 0 })

    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).resolves.toBe(true)
    expect(chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(3)
  })

  test('throws the final chaintracks lookup error after retries', async () => {
    const chaintracks = makeChaintracksClient([new Error('first failure'), new Error('final failure')])
    const tracker = new ChaintracksChainTracker('main', chaintracks, { maxRetries: 2, retryDelayMs: 0 })

    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).rejects.toThrow(
      'final failure'
    )
    expect(chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(2)
  })

  test('traces retry attempts and cache disposition without roots or headers', async () => {
    const events: any[] = []
    let nextSpanId = 1
    const chaintracks = makeChaintracksClient([undefined, HEADER_877599, HEADER_877599])
    const tracker = new ChaintracksChainTracker('main', chaintracks, {
      maxRetries: 2,
      retryDelayMs: 0,
      telemetry: {
        sink: {
          capture: event => events.push(event)
        },
        traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, '0')
      }
    })

    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).resolves.toBe(true)
    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).resolves.toBe(true)
    await expect(tracker.currentHeight()).resolves.toBe(950000)

    const attempts = events.filter(event => event.name === 'wallet.chaintracks.find_header')
    const validations = events.filter(event => event.name === 'wallet.chaintracks.validate_root')
    expect(attempts).toHaveLength(3)
    expect(attempts.map(event => event.attributes['retry.attempt'])).toEqual([1, 2, 1])
    expect(validations).toHaveLength(2)
    expect(validations[0].attributes).toMatchObject({
      'chaintracks.cache_hit': false,
      'chaintracks.valid': true
    })
    expect(validations[1].attributes).toMatchObject({
      'chaintracks.cache_hit': false,
      'chaintracks.valid': true
    })
    expect(events.find(event => event.name === 'wallet.chaintracks.current_height')).toMatchObject({
      spanStatus: 'ok'
    })
    expect(JSON.stringify(events)).not.toContain(HEADER_877599.merkleRoot)
    expect(JSON.stringify(events)).not.toContain(HEADER_877599.previousHash)
  })

  test('reads the current canonical root on every request after a same-height reorg', async () => {
    const reorged = { ...HEADER_877599, merkleRoot: '11'.repeat(32) }
    const chaintracks = makeChaintracksClient([HEADER_877599, reorged])
    const tracker = new ChaintracksChainTracker('main', chaintracks, { maxRetries: 1 })

    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).resolves.toBe(true)
    await expect(tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)).resolves.toBe(false)
    expect(chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(2)
  })

  test('rejects a header result from a provider replaced while its request is pending', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const oldProvider = makeChaintracksClient([])
    oldProvider.findHeaderForHeight.mockImplementation(async () => {
      await pending
      return HEADER_877599
    })
    const replacement = makeChaintracksClient([HEADER_877599])
    const tracker = new ChaintracksChainTracker('main', oldProvider, { maxRetries: 3, retryDelayMs: 0 })

    const request = tracker.isValidRootForHeight(HEADER_877599.merkleRoot, HEADER_877599.height)
    tracker.chaintracks = replacement
    tracker.chaintracks = oldProvider
    release!()

    await expect(request).rejects.toThrow('provider changed')
    expect(oldProvider.findHeaderForHeight).toHaveBeenCalledTimes(1)
    expect(tracker.getVerificationContext()).toContain('chaintracks:2:')
    expect(tracker.cache).toEqual({})
  })

  test('changes a token for every reorg event, including an ABA tip, and releases its listener', async () => {
    let listener: (() => void) | undefined
    const provider = makeChaintracksClient([])
    provider.findChainTipHash = jest.fn(async () => 'aa'.repeat(32))
    provider.subscribeReorgs = jest.fn(async callback => {
      listener = callback
      return 'reorg-1'
    })
    provider.unsubscribe = jest.fn(async () => true)
    const tracker = new ChaintracksChainTracker('main', provider)

    const before = await tracker.getVerificationContextToken()
    listener!()
    const after = await tracker.getVerificationContextToken()
    expect(after).not.toBe(before)
    await tracker.dispose()
    expect(provider.unsubscribe).toHaveBeenCalledWith('reorg-1')
  })

  test('unsubscribes a deferred registration after provider replacement and obtains a fresh subscription', async () => {
    let release: ((value: string) => void) | undefined
    const pending = new Promise<string>(resolve => {
      release = resolve
    })
    const oldProvider = makeChaintracksClient([])
    oldProvider.findChainTipHash = jest.fn(async () => 'aa'.repeat(32))
    oldProvider.subscribeReorgs = jest.fn(async () => await pending)
    oldProvider.unsubscribe = jest.fn(async () => true)
    const replacement = makeChaintracksClient([])
    replacement.findChainTipHash = jest.fn(async () => 'bb'.repeat(32))
    replacement.subscribeReorgs = jest.fn(async () => 'fresh-subscription')
    replacement.unsubscribe = jest.fn(async () => true)
    const tracker = new ChaintracksChainTracker('main', oldProvider)

    const staleToken = tracker.getVerificationContextToken()
    tracker.chaintracks = replacement
    release!('stale-subscription')
    await expect(staleToken).rejects.toThrow('provider changed')
    expect(oldProvider.unsubscribe).toHaveBeenCalledWith('stale-subscription')
    await expect(tracker.getVerificationContextToken()).resolves.toContain('bb'.repeat(32))
    expect(replacement.subscribeReorgs).toHaveBeenCalledTimes(1)
  })

  test('rejects a token when dispose races with pending registration on the same provider', async () => {
    let release: ((value: string) => void) | undefined
    const pending = new Promise<string>(resolve => {
      release = resolve
    })
    const provider = makeChaintracksClient([])
    provider.findChainTipHash = jest.fn(async () => 'aa'.repeat(32))
    provider.subscribeReorgs = jest.fn(async () => await pending)
    provider.unsubscribe = jest.fn(async () => true)
    const tracker = new ChaintracksChainTracker('main', provider)

    const token = tracker.getVerificationContextToken()
    const disposed = tracker.dispose()
    release!('disposed-pending')
    await disposed
    await expect(token).rejects.toThrow('provider changed')
    expect(provider.unsubscribe).toHaveBeenCalledWith('disposed-pending')
  })

  test('uses the HTTP Chaintracks client without attempting its unsupported reorg subscription', async () => {
    const provider = new ChaintracksServiceClient('main', 'https://chaintracks.example')
    expect(provider.supportsReorgEvents).toBe(false)
    jest.spyOn(provider, 'findChainTipHash').mockResolvedValue('aa'.repeat(32))
    jest.spyOn(provider, 'subscribeReorgs')
    const tracker = new ChaintracksChainTracker('main', provider)

    await expect(tracker.getVerificationContextToken()).resolves.toContain('aa'.repeat(32))
    expect(provider.subscribeReorgs).not.toHaveBeenCalled()
  })

  test('does not hide a registration failure from a built-in client that promises reorg events', async () => {
    class PromisingEventsClient extends ChaintracksServiceClient {
      override readonly supportsReorgEvents = true
    }
    const provider = new PromisingEventsClient('main', 'https://chaintracks.example')
    expect(provider.supportsReorgEvents).toBe(true)
    jest.spyOn(provider, 'findChainTipHash').mockResolvedValue('aa'.repeat(32))
    const subscribe = jest.spyOn(provider, 'subscribeReorgs')
    const tracker = new ChaintracksChainTracker('main', provider)

    await expect(tracker.getVerificationContextToken()).rejects.toThrow('Method not implemented.')
    expect(subscribe).toHaveBeenCalled()
  })
})

async function testChaintracksChaintracker(chain: sdk.Chain) {
  const tracker = new ChaintracksChainTracker(chain)
  const height = await tracker.currentHeight()
  expect(height).toBeGreaterThan(877598)
  const okMain = await tracker.isValidRootForHeight(
    '2bf2edb5fa42aa773c6c13bc90e097b4e7de7ca1df2227f433be75ceace339e9',
    877599
  )
  expect(okMain).toBe(chain === 'main')
  const okTest = await tracker.isValidRootForHeight(
    '5513f13554442588dd9acf395072bf1d2e7d5d360fbc42d3ab1fa2026b17c200',
    1654265
  )
  expect(okTest).toBe(chain === 'test')
}

function jsonResponse(body: unknown): any {
  return { ok: true, status: 200, json: async () => body }
}

function makeChaintracksClient(responses: Array<BlockHeader | undefined | Error>): any {
  return {
    getPresentHeight: jest.fn(async () => 950000),
    findHeaderForHeight: jest.fn(async () => {
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    })
  }
}
