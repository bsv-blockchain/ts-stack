import { GoChaintracksServiceClient } from '../GoChaintracksServiceClient'

function jsonResponse (data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function binaryResponse (data: Uint8Array): Response {
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' }
  })
}

function sseResponse (events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start (controller) {
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
      fetch: fetchMock
    })

    const headers: unknown[] = []
    const id = await client.subscribeHeaders(header => headers.push(header))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(headers).toEqual([tip])
    expect(await client.unsubscribe(id)).toBe(false)
  })
})
