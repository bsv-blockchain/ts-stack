import { GoChaintracksServiceClient } from '../GoChaintracksServiceClient'

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
      ['teranodescalingtestnet', 'tstn']
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
  })

  test('reads go-chaintracks v2 height, tip, headers, and hash lookups', async () => {
    const tip = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 2,
      nonce: 3,
      height: 99,
      hash: '22'.repeat(32)
    }
    const fetchMock = jest.fn(async (url: string) => {
      if (url === 'https://arcade.example.com/chaintracks/v2/height') return jsonResponse({ height: 99 })
      if (url === 'https://arcade.example.com/chaintracks/v2/tip') return jsonResponse(tip)
      if (url === 'https://arcade.example.com/chaintracks/v2/header/height/99') return jsonResponse(tip)
      if (url === `https://arcade.example.com/chaintracks/v2/header/hash/${tip.hash}`) return jsonResponse(tip)
      if (url === 'https://arcade.example.com/chaintracks/v2/headers.bin?height=99&count=1') {
        return binaryResponse(Uint8Array.from([1, 2, 3, 4]))
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
    expect(await client.getHeaders(99, 1)).toBe('01020304')
    expect(await client.findHeaderForHeight(100)).toBeUndefined()
  })

  test('subscribeHeaders parses tip stream SSE data and unsubscribe is idempotent', async () => {
    const tip = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 2,
      nonce: 3,
      height: 99,
      hash: '22'.repeat(32)
    }
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
    const first = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 2,
      nonce: 3,
      height: 1,
      hash: '22'.repeat(32)
    }
    const second = { ...first, height: 2, hash: '33'.repeat(32) }
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
    const oldTip = { height: 1, hash: '11'.repeat(32) }
    const newTip = { height: 2, hash: '22'.repeat(32) }
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
        jsonResponse({ status: 'error', description: 'upstream rejected lookup' })
      ) as unknown as typeof fetch
    })
    await expect(envelope.findHeaderForHeight(4)).rejects.toThrow('upstream rejected lookup')

    const aborted = new AbortController()
    aborted.abort()
    await expect((envelope as any).waitForReconnect(1, aborted.signal)).resolves.toBeUndefined()
  })
})
