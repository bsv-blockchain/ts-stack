import { GoChaintracksServiceClient } from '../GoChaintracksServiceClient'
import type { BlockHeader } from '../Api/BlockHeaderApi'
import { blockHash, deserializeBaseBlockHeaders, genesisBuffer } from '../util/blockHeaderUtilities'

function validMainHeader(height: number): BlockHeader {
  const base = deserializeBaseBlockHeaders(genesisBuffer('main'))[0]!
  return { ...base, height, hash: blockHash(base) }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function binaryResponse(data: Uint8Array): Response {
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' }
  })
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

describe('GoChaintracksServiceClient', () => {
  test('rejects unsafe endpoint and resource-limit configuration', () => {
    for (const url of [
      'ftp://chaintracks.example/v2',
      'https://user:pass@chaintracks.example/v2',
      'https://chaintracks.example/v2?network=main',
      'https://chaintracks.example/v2#tip'
    ]) {
      expect(() => new GoChaintracksServiceClient('main', url)).toThrow('serviceUrl')
    }
    expect(
      () =>
        new GoChaintracksServiceClient('main', 'https://chaintracks.example', {
          apiPrefix: '/../private'
        })
    ).toThrow('apiPrefix')
    expect(
      () =>
        new GoChaintracksServiceClient('main', 'https://chaintracks.example', {
          maxJsonResponseBytes: 0
        })
    ).toThrow('maxJsonResponseBytes')
  })

  test('rejects noncanonical chains and accessor-backed or malformed options without invoking accessors', () => {
    expect(() => new GoChaintracksServiceClient('mainnet' as never, 'https://chaintracks.example')).toThrow(
      'canonical ChainTracks network'
    )
    expect(() => new GoChaintracksServiceClient('main', 'https://chaintracks.example', null as never)).toThrow(
      'plain data object'
    )
    expect(() => new GoChaintracksServiceClient('main', 'https://chaintracks.example', [] as never)).toThrow(
      'plain data object'
    )
    const getter = jest.fn(() => fetch)
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'fetch', { enumerable: true, get: getter })
    expect(() => new GoChaintracksServiceClient('main', 'https://chaintracks.example', accessor as never)).toThrow(
      'accessor-free'
    )
    expect(getter).not.toHaveBeenCalled()
    expect(() => new GoChaintracksServiceClient('main', 'https://chaintracks.example', { fetch: 1 as never })).toThrow(
      'fetch must be a function'
    )
    expect(
      () => new GoChaintracksServiceClient('main', 'https://chaintracks.example', { maxReorgHeaders: 100_001 })
    ).toThrow('maxReorgHeaders')
    expect(
      () => new GoChaintracksServiceClient('main', 'https://chaintracks.example', { requestTimeoutMsecs: 3_600_001 })
    ).toThrow('requestTimeoutMsecs')
  })

  test('rejects timeout settings that could create an unbounded reconnect loop', () => {
    expect(
      () =>
        new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
          reconnectWaitMsecs: 0
        })
    ).toThrow('reconnectWaitMsecs must be a positive integer')
    expect(
      () =>
        new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
          reconnectWaitMsecs: 100,
          reconnectWaitMaxMsecs: 10
        })
    ).toThrow('reconnectWaitMaxMsecs must be greater than or equal')
  })

  test('unwraps the legacy service envelope while accepting raw go-chaintracks values', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/network')) return jsonResponse({ status: 'success', value: 'teratestnet' })
      if (url.endsWith('/height')) return jsonResponse({ status: 'success', value: { height: 44 } })
      return jsonResponse({ status: 'error', description: 'missing' })
    }) as unknown as typeof fetch
    const client = new GoChaintracksServiceClient('ttn', 'https://chaintracks.example/v2', { fetch: fetchMock })

    await expect(client.getChain()).resolves.toBe('ttn')
    await expect(client.getPresentHeight()).resolves.toBe(44)
  })

  test('accepts raw height and every supported upstream network alias while rejecting unknown networks', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async (url: string) =>
        url.endsWith('/height') ? jsonResponse(7) : jsonResponse('mainnet')
      ) as unknown as typeof fetch
    })
    await expect(client.getPresentHeight()).resolves.toBe(7)
    await expect(client.getChain()).resolves.toBe('main')

    for (const [alias, chain] of [
      ['scalingtestnet', 'stn'],
      ['teranodescalingtestnet', 'tstn'],
      ['regtest', 'regtest']
    ] as const) {
      const aliasClient = new GoChaintracksServiceClient(chain, 'https://chaintracks.example/v2', {
        fetch: jest.fn(async () => jsonResponse(alias)) as unknown as typeof fetch
      })
      await expect(aliasClient.getChain()).resolves.toBe(chain)
    }

    const unknown = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse('unknownnet')) as unknown as typeof fetch
    })
    await expect(unknown.getChain()).rejects.toThrow("Unsupported ChainTracks upstream network 'unknownnet'")

    const mismatch = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse('testnet')) as unknown as typeof fetch
    })
    await expect(mismatch.getChain()).rejects.toThrow("does not match configured chain 'main'")
  })

  test('rejects non-data or incomplete network and height response records', async () => {
    const networkGetter = jest.fn(() => 'main')
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'network', { enumerable: true, get: networkGetter })
    const direct = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2') as any
    expect(() => direct.readExactRecord(accessor, ['network'], 'network response')).toThrow('invalid network response')
    const values = [{}, { network: 1 }, { network: 'main', extra: true }]
    for (const value of values) {
      const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
        fetch: jest.fn(async () => jsonResponse(value)) as unknown as typeof fetch
      })
      await expect(client.getChain()).rejects.toThrow(/invalid (network|network response)/)
    }
    expect(networkGetter).not.toHaveBeenCalled()

    const heightClient = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse({})) as unknown as typeof fetch
    })
    await expect(heightClient.getPresentHeight()).rejects.toThrow('invalid height response')
  })

  test('validates public query arguments before transport and reports unsupported writes', async () => {
    const fetchMock = jest.fn()
    const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: fetchMock as unknown as typeof fetch
    })
    await expect(client.getHeaders(-1, 1)).rejects.toThrow('height')
    await expect(client.getHeaders(0, 0)).rejects.toThrow('count')
    await expect(client.findHeaderForHeight(0x80000000)).rejects.toThrow('height')
    await expect(client.addHeader(validMainHeader(0))).rejects.toThrow('not supported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('binds header results to valid proof, requested height, and requested hash', async () => {
    const valid = validMainHeader(9)
    const invalidHash = { ...valid, hash: '11'.repeat(32) }
    const invalidClient = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse(invalidHash)) as unknown as typeof fetch
    })
    await expect(invalidClient.findChainTipHeader()).rejects.toThrow('Header hash is invalid')

    const heightClient = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse(validMainHeader(10))) as unknown as typeof fetch
    })
    await expect(heightClient.findHeaderForHeight(9)).rejects.toThrow('wrong height')

    const hashClient = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse(valid)) as unknown as typeof fetch
    })
    await expect(hashClient.findHeaderForBlockHash('ff'.repeat(32))).rejects.toThrow('wrong hash')
    await expect(hashClient.findHeaderForBlockHash('../height/0')).rejects.toThrow('32 hexadecimal')

    const partialLive = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => jsonResponse({ ...valid, chainWork: '00'.repeat(32) })) as unknown as typeof fetch
    })
    await expect(partialLive.findChainTipHeader()).rejects.toThrow('invalid chain tip')
  })

  test('keeps the request deadline active through bounded JSON body consumption', async () => {
    const oversized = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      maxJsonResponseBytes: 16,
      fetch: jest.fn(
        async () =>
          new Response(JSON.stringify({ height: 1, padding: 'x'.repeat(32) }), {
            headers: { 'Content-Type': 'application/json' }
          })
      ) as unknown as typeof fetch
    })
    await expect(oversized.getPresentHeight()).rejects.toThrow('byte limit')

    const stalled = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      requestTimeoutMsecs: 10,
      fetch: jest.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {}
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch
    })
    await expect(stalled.getPresentHeight()).rejects.toThrow('deadline')
  })

  test('bounds and exactly frames binary header responses before returning them', async () => {
    const malformed = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      maxBinaryResponseBytes: 160,
      fetch: jest.fn(async () => binaryResponse(new Uint8Array(79))) as unknown as typeof fetch
    })
    await expect(malformed.getHeaders(0, 1)).rejects.toThrow('non-canonical')

    const fetchMock = jest.fn(async () => binaryResponse(new Uint8Array(80)))
    const capped = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      maxBinaryResponseBytes: 80,
      fetch: fetchMock as unknown as typeof fetch
    })
    await expect(capped.getHeaders(0, 2)).rejects.toThrow('count exceeds')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects invalid, oversized, and stalled SSE events before callbacks', async () => {
    const invalidHeader = { ...validMainHeader(1), hash: '44'.repeat(32) }
    const callback = jest.fn()
    const invalid = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      fetch: jest.fn(async () => sseResponse([`data: ${JSON.stringify(invalidHeader)}\n\n`])) as unknown as typeof fetch
    })
    await expect(
      (invalid as any).runSse('/tip/stream', new AbortController().signal, (payload: unknown) =>
        callback((invalid as any).validateRemoteHeader(payload, 'tip stream event'))
      )
    ).rejects.toThrow('Header hash is invalid')
    expect(callback).not.toHaveBeenCalled()

    const oversized = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      maxSseEventBytes: 64,
      fetch: jest.fn(async () => sseResponse([`data: ${'x'.repeat(65)}\n\n`])) as unknown as typeof fetch
    })
    await expect((oversized as any).runSse('/tip/stream', new AbortController().signal, callback)).rejects.toThrow(
      /SSE (chunk|event) exceeds/
    )

    const stalled = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
      streamIdleTimeoutMsecs: 10,
      fetch: jest.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { 'Content-Type': 'text/event-stream' }
          })
      ) as unknown as typeof fetch
    })
    await expect((stalled as any).runSse('/tip/stream', new AbortController().signal, callback)).rejects.toThrow(
      'idle timeout'
    )
  })

  test('reads go-chaintracks v2 height, tip, headers, and hash lookups', async () => {
    const tip = validMainHeader(99)
    const fetchMock = jest.fn(async (url: string) => {
      if (url === 'https://arcade.example.com/chaintracks/v2/height') return jsonResponse({ height: 99 })
      if (url === 'https://arcade.example.com/chaintracks/v2/tip') return jsonResponse(tip)
      if (url === 'https://arcade.example.com/chaintracks/v2/header/height/99') return jsonResponse(tip)
      if (url === `https://arcade.example.com/chaintracks/v2/header/hash/${tip.hash}`) return jsonResponse(tip)
      if (url === 'https://arcade.example.com/chaintracks/v2/headers.bin?height=99&count=1') {
        return binaryResponse(Uint8Array.from(genesisBuffer('main')))
      }
      return jsonResponse({ error: 'not found' }, 404)
    }) as unknown as typeof fetch

    const client = new GoChaintracksServiceClient('main', 'https://arcade.example.com', {
      apiPrefix: '/chaintracks/v2',
      fetch: fetchMock
    })

    expect(await client.getPresentHeight()).toBe(99)
    expect(await client.findChainTipHeader()).toEqual(tip)
    expect(await client.findChainTipHash()).toBe(tip.hash)
    expect(await client.findHeaderForHeight(99)).toEqual(tip)
    expect(await client.findHeaderForBlockHash(tip.hash)).toEqual(tip)
    expect(await client.getHeaders(99, 1)).toBe(Buffer.from(genesisBuffer('main')).toString('hex'))
    expect(await client.findHeaderForHeight(100)).toBeUndefined()
  })

  test('subscribeHeaders parses tip stream SSE data and unsubscribe is idempotent', async () => {
    const tip = validMainHeader(99)
    const fetchMock = jest.fn(async (url: string) => {
      if (url === 'https://arcade.example.com/chaintracks/v2/tip/stream') {
        return sseResponse([`: keepalive\n\n`, `data: ${JSON.stringify(tip)}\n\n`])
      }
      return jsonResponse({ error: 'not found' }, 404)
    }) as unknown as typeof fetch
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example.com/chaintracks/v2', {
      fetch: fetchMock,
      reconnectWaitMsecs: 10000,
      reconnectWaitMaxMsecs: 10000
    })

    const headers: unknown[] = []
    const id = await client.subscribeHeaders(header => headers.push(header))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(headers).toEqual([tip])
    expect(await client.unsubscribe(id)).toBe(true)
    expect(await client.unsubscribe(id)).toBe(false)
  })

  test('reconnects a closed SSE stream and accepts CRLF framing', async () => {
    const first = validMainHeader(1)
    const second = validMainHeader(2)
    let requests = 0
    const fetchMock = jest.fn(async () => {
      requests++
      const event = requests === 1 ? first : second
      return sseResponse([`data: ${JSON.stringify(event)}\r\n\r\n`])
    }) as unknown as typeof fetch
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: fetchMock,
      reconnectWaitMsecs: 1,
      reconnectWaitMaxMsecs: 1
    })
    const received: unknown[] = []
    const id = await client.subscribeHeaders(header => received.push(header))
    for (let attempt = 0; received.length < 2 && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }

    expect(received.slice(0, 2)).toEqual([first, second])
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    await expect(client.unsubscribe(id)).resolves.toBe(true)
  })

  test('reconnects after a stream request fails and delivers reorg events', async () => {
    const oldTip = validMainHeader(1)
    const newTip = validMainHeader(2)
    let requests = 0
    const fetchMock = jest.fn(async () => {
      requests++
      if (requests === 1) throw new Error('temporary stream failure')
      return sseResponse([`data: ${JSON.stringify({ depth: 1, oldTip, newTip, deactivatedHeaders: [oldTip] })}\n\n`])
    }) as unknown as typeof fetch
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: fetchMock,
      reconnectWaitMsecs: 1,
      reconnectWaitMaxMsecs: 1
    })
    const listener = jest.fn()
    const id = await client.subscribeReorgs(listener)
    for (let attempt = 0; listener.mock.calls.length === 0 && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }

    expect(listener).toHaveBeenCalledWith(1, oldTip, newTip, [oldTip])
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    await expect(client.unsubscribe(id)).resolves.toBe(true)
  })

  test('validates listeners, subscription ids, and reorg deactivation topology', async () => {
    const oldTip = validMainHeader(1)
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: jest.fn(async () =>
        sseResponse([
          `data: ${JSON.stringify({
            depth: 1,
            oldTip,
            newTip: validMainHeader(2),
            deactivatedHeaders: [oldTip, oldTip]
          })}\n\n`
        ])
      ) as unknown as typeof fetch,
      reconnectWaitMsecs: 5,
      reconnectWaitMaxMsecs: 5
    })
    await expect(client.subscribeHeaders(undefined as never)).rejects.toThrow('listener')
    await expect(client.unsubscribe('')).rejects.toThrow('subscriptionId')

    const listener = jest.fn()
    const id = await client.subscribeReorgs(listener)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(listener).not.toHaveBeenCalled()
    await expect(client.unsubscribe(id)).resolves.toBe(true)
  })

  test('validates every reorg topology boundary before notifying the listener', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      maxReorgHeaders: 2,
      fetch: jest.fn() as unknown as typeof fetch
    }) as any
    let consume!: (payload: unknown) => void
    jest.spyOn(client, 'subscribe').mockImplementation(async (_type, _path, onPayload) => {
      consume = onPayload
      return 'reorg-test'
    })
    const listener = jest.fn()
    await client.subscribeReorgs(listener)
    const oldTip = validMainHeader(2)
    const otherBase = deserializeBaseBlockHeaders(genesisBuffer('test'))[0]!
    const other = { ...otherBase, height: 1, hash: blockHash(otherBase) }
    const newTip = validMainHeader(3)

    for (const payload of [
      { depth: -1, oldTip, newTip },
      { depth: 1, oldTip, newTip, deactivatedHeaders: {} },
      { depth: 1, oldTip, newTip, deactivatedHeaders: [oldTip, other] },
      { depth: 1, oldTip, newTip, deactivatedHeaders: [other] },
      { depth: 2, oldTip, newTip, deactivatedHeaders: [oldTip, oldTip] },
      { depth: 2, oldTip, newTip, deactivatedHeaders: [oldTip, other] }
    ]) {
      expect(() => consume(payload)).toThrow()
    }
    expect(listener).not.toHaveBeenCalled()
  })

  test('fails closed when subscription capacity or identifier space is exhausted', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: jest.fn() as unknown as typeof fetch
    }) as any
    Object.defineProperty(client, 'subscriptions', { value: { size: 100_000 }, configurable: true })
    await expect(client.subscribeHeaders(jest.fn())).rejects.toThrow('capacity')

    Object.defineProperty(client, 'subscriptions', { value: new Map(), configurable: true })
    client.nextSubscriptionId = 0
    await expect(client.subscribeHeaders(jest.fn())).rejects.toThrow('id space')
  })

  test('ignores comments and malformed SSE frames while preserving an incomplete tail', () => {
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2') as any
    const listener = jest.fn()
    expect(
      client.processSseBuffer(': keepalive\n\ndata: {broken\n\ndata: {"height":1}\n\ndata: {"tail"', listener)
    ).toBe('data: {"tail"')
    expect(listener).toHaveBeenCalledWith({ height: 1 })
  })

  test('rejects invalid lengths and non-byte streamed bodies and accepts a bodyless response', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://arcade.example/v2') as any
    const signal = new AbortController().signal
    await expect(client.readBoundedBody({ headers: { get: () => '01' }, body: null }, 10, signal)).rejects.toThrow(
      'Content-Length'
    )
    await expect(client.readBoundedBody({ headers: { get: () => '11' }, body: null }, 10, signal)).rejects.toThrow(
      'byte limit'
    )
    await expect(client.readBoundedBody({ headers: { get: () => null }, body: null }, 10, signal)).resolves.toEqual(
      new Uint8Array()
    )

    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    const read = jest.fn().mockResolvedValueOnce({ done: false, value: [1] })
    await expect(
      client.readBoundedBody(
        { headers: { get: () => null }, body: { getReader: () => ({ read, cancel, releaseLock }) } },
        10,
        signal
      )
    ).rejects.toThrow('non-byte')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  test('reports SSE response failures and legacy error envelopes', async () => {
    const failed = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: jest.fn(
        async () => new Response(null, { status: 503, statusText: 'Unavailable' })
      ) as unknown as typeof fetch
    })
    await expect((failed as any).runSse('/tip/stream', new AbortController().signal, () => {})).rejects.toThrow(
      'failed 503 Unavailable'
    )

    const bodyless = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', body: null })) as unknown as typeof fetch
    })
    await expect((bodyless as any).runSse('/tip/stream', new AbortController().signal, () => {})).rejects.toThrow(
      'returned no response body'
    )

    const envelope = new GoChaintracksServiceClient('main', 'https://arcade.example/v2', {
      fetch: jest.fn(async () =>
        jsonResponse({ status: 'error', description: 'upstream rejected\r\ninjected lookup' })
      ) as unknown as typeof fetch
    })
    await expect(envelope.findHeaderForHeight(4)).rejects.toThrow('upstream rejected injected lookup')

    const aborted = new AbortController()
    aborted.abort()
    await expect((envelope as any).waitForReconnect(1, aborted.signal)).resolves.toBeUndefined()
  })
})
