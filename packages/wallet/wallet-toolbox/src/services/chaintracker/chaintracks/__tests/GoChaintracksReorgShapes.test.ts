import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GoChaintracksServiceClient, GoChaintracksServiceClientOptions } from '../GoChaintracksServiceClient'
import { deserializeBlockHeaders } from '../util/blockHeaderUtilities'

// Consecutive public headers are a decoding fixture, not a mined fork.
const headers = deserializeBlockHeaders(
  0,
  Array.from(readFileSync(join(__dirname, 'data/cdnTest402/mainNet_0.headers')))
)
const [ancestor, parent, oldTip, newTip] = headers
const goEvent = { depth: 2, commonAncestor: ancestor, newTip, orphanedHashes: [oldTip.hash, parent.hash] }
const tsEvent = { depth: 2, oldTip, newTip, deactivatedHeaders: [oldTip, parent] }
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

function harness(events: unknown[], options: GoChaintracksServiceClientOptions = {}, lookup?: typeof fetch) {
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/reorg/stream')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events)
              controller.enqueue(
                new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
              )
          }
        })
      )
    }
    if (lookup != null) return await lookup(input, init)
    const header = headers.find(h => url.endsWith(`/header/hash/${h.hash}`))
    return new Response(JSON.stringify({ status: 'success', value: header }), { status: header == null ? 404 : 200 })
  })
  const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
    fetch: fetcher as typeof fetch,
    reconnectWaitMsecs: 10000,
    ...options
  })
  return { client, fetcher }
}

async function replay(
  events: unknown[],
  check: (client: GoChaintracksServiceClient, listener: jest.Mock, fetcher: jest.Mock) => void,
  options: GoChaintracksServiceClientOptions = {},
  lookup?: typeof fetch
) {
  const { client, fetcher } = harness(events, options, lookup)
  const listener = jest.fn()
  const id = await client.subscribeReorgs(listener)
  try {
    await flush()
    check(client, listener, fetcher)
  } finally {
    await client.unsubscribe(id)
  }
}

// Structural casts keep this witness executable at the base before the additive API exists.
const errors = (client: GoChaintracksServiceClient) =>
  (client as unknown as { streamErrorCount: number }).streamErrorCount

test('preserves the TypeScript shape', async () => {
  await replay([tsEvent], (_client, listener) =>
    expect(listener).toHaveBeenCalledWith(2, oldTip, newTip, [oldTip, parent])
  )
})

test('normalizes the Go shape using only announced hash lookups', async () => {
  await replay([goEvent], (_client, listener, fetcher) => {
    expect(listener).toHaveBeenCalledWith(2, oldTip, newTip, [oldTip, parent])
    expect(fetcher.mock.calls.map(call => String(call[0]).split('/v2')[1])).toEqual([
      '/reorg/stream',
      `/header/hash/${oldTip.hash}`,
      `/header/hash/${parent.hash}`
    ])
  })
})

test.each([
  ['malformed JSON', '{broken'],
  ['unknown keys', { ...goEvent, extra: true }],
  ['inconsistent depth', { ...goEvent, depth: 1 }],
  ['duplicate hashes', { ...goEvent, orphanedHashes: [oldTip.hash, oldTip.hash] }],
  ['missing hashes', { ...goEvent, orphanedHashes: [oldTip.hash, '11'.repeat(32)] }]
])('reports %s without notifying the listener', async (_name, event) => {
  await replay([event], (client, listener) => {
    expect(listener).not.toHaveBeenCalled()
    expect(errors(client)).toBe(1)
  })
})

test('rejects an over-limit list before orphan lookups', async () => {
  await replay(
    [goEvent],
    (client, listener, fetcher) => {
      expect(errors(client)).toBe(1)
      expect(listener).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
    { maxReorgHeaders: 1 }
  )
})

test('isolates a throwing observer and delivers the next valid event', async () => {
  const observer = jest.fn((_message: string) => {
    throw new Error('observer failed')
  })
  await replay(
    ['{broken', goEvent],
    (client, listener) => {
      expect(errors(client)).toBe(1)
      expect(observer).toHaveBeenCalledTimes(1)
      expect(observer.mock.calls[0][0].length).toBeLessThanOrEqual(512)
      expect(listener).toHaveBeenCalledTimes(1)
    },
    { onStreamError: observer } as GoChaintracksServiceClientOptions
  )
})

test('unsubscribe aborts a pending orphan lookup without delivering an event', async () => {
  let lookupSignal: AbortSignal | undefined
  const { client } = harness([goEvent], {}, (async (_input, init) => {
    lookupSignal = init?.signal ?? undefined
    return await new Promise<Response>((_resolve, reject) => {
      lookupSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as typeof fetch)
  const listener = jest.fn()
  const id = await client.subscribeReorgs(listener)
  try {
    await flush()
    expect(lookupSignal).toBeDefined()
  } finally {
    await client.unsubscribe(id)
  }
  expect(lookupSignal?.aborted).toBe(true)
  expect(listener).not.toHaveBeenCalled()
  expect(errors(client)).toBe(0)
})

test.each([
  ['unlinked ancestor', { ...goEvent, commonAncestor: newTip }],
  ['unlinked orphans', { ...goEvent, orphanedHashes: [oldTip.hash, ancestor.hash] }],
  ['invalid proof', { ...goEvent, newTip: { ...newTip, nonce: 0 } }],
  ['invalid hash', { ...goEvent, orphanedHashes: [oldTip.hash, 'bad'] }]
])('rejects %s', async (_name, event) => {
  await replay([event], (client, listener) => {
    expect(errors(client)).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  })
})

test('rejects a lookup response for a different hash', async () => {
  await replay(
    [goEvent],
    (client, listener) => {
      expect(errors(client)).toBe(1)
      expect(listener).not.toHaveBeenCalled()
    },
    {},
    (async () => new Response(JSON.stringify({ status: 'success', value: parent }))) as typeof fetch
  )
})

test('bounds reconnect diagnostics and reports stream failures', async () => {
  const observer = jest.fn((_message: string) => {})
  const { client } = harness([], {
    fetch: (async () => {
      throw new Error('bad\n' + 'x'.repeat(1000))
    }) as typeof fetch,
    onStreamError: observer
  })
  const id = await client.subscribeReorgs(jest.fn())
  try {
    await flush()
    expect(errors(client)).toBe(1)
    expect(observer.mock.calls[0][0]).toHaveLength(512)
    expect(observer.mock.calls[0][0]).not.toMatch(/[\r\n]/)
  } finally {
    await client.unsubscribe(id)
  }
})

test('uses one deadline across multiple orphan lookups', async () => {
  jest.useFakeTimers()
  let calls = 0
  let pendingSignal: AbortSignal | undefined
  const { client } = harness([goEvent], { requestTimeoutMsecs: 100 }, (async (_input, init) => {
    calls++
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 60))
      return new Response(JSON.stringify({ status: 'success', value: oldTip }))
    }
    pendingSignal = init?.signal ?? undefined
    return await new Promise<Response>((_resolve, reject) => {
      pendingSignal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true })
    })
  }) as typeof fetch)
  const listener = jest.fn()
  const id = await client.subscribeReorgs(listener)
  try {
    await flush()
    await jest.advanceTimersByTimeAsync(60)
    await flush()
    expect(calls).toBe(2)
    await jest.advanceTimersByTimeAsync(40)
    await flush()
    expect(pendingSignal?.aborted).toBe(true)
    expect(errors(client)).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  } finally {
    await client.unsubscribe(id)
    jest.useRealTimers()
  }
})

test.each([
  ['unknown keys', { ...goEvent, extra: true }],
  ['invalid depth', { ...goEvent, depth: -1 }],
  ['JSON syntax', '{broken']
])('continues after rejected %s and delivers the following event on the same stream', async (_name, invalid) => {
  await replay([invalid, tsEvent], (client, listener) => {
    expect(client.streamErrorCount).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(2, oldTip, newTip, [oldTip, parent])
  })
})

test('accepts an empty Go deactivation list without orphan requests', async () => {
  await replay([{ depth: 0, commonAncestor: ancestor, newTip, orphanedHashes: [] }], (_client, listener, fetcher) => {
    expect(listener).toHaveBeenCalledWith(0, ancestor, newTip, [])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

test('rejects a non-function diagnostic observer', () => {
  expect(() => harness([], { onStreamError: 1 as never })).toThrow('onStreamError must be a function')
})

test('many comment frames retain bounded work and let timers run before the following event', async () => {
  let finish!: () => void
  const delivered = new Promise<void>(resolve => {
    finish = resolve
  })
  const listener = jest.fn(finish)
  const body = ': comment\r\n\r\n'.repeat(25_000) + `data: ${JSON.stringify(tsEvent)}\n\n`
  const { client } = harness([], { fetch: (async () => new Response(body)) as typeof fetch })
  const id = await client.subscribeReorgs(listener)
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(listener).not.toHaveBeenCalled()
    await delivered
    expect(listener).toHaveBeenCalledTimes(1)
    expect(client.streamErrorCount).toBe(0)
  } finally {
    await client.unsubscribe(id)
  }
})

test('unsubscribe interrupts a chunk containing many empty frames before its last event', async () => {
  const listener = jest.fn()
  const body = '\n\n'.repeat(100_000) + `data: ${JSON.stringify(goEvent)}\n\n`
  const { client, fetcher } = harness([], { fetch: (async () => new Response(body)) as typeof fetch })
  const id = await client.subscribeReorgs(listener)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await expect(client.unsubscribe(id)).resolves.toBe(true)
  expect(listener).not.toHaveBeenCalled()
  expect(client.streamErrorCount).toBe(0)
  expect(fetcher).not.toHaveBeenCalled()
})

test.each([
  ['Go keys', { ...goEvent, extra: true }],
  ['JSON syntax', '{broken']
])('rejects malformed %s without losing TS and Go events in one actual response chunk', async (_name, invalid) => {
  const body = [invalid, tsEvent, goEvent]
    .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('')
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/reorg/stream')) return new Response(body)
    const header = headers.find(item => url.endsWith(`/header/hash/${item.hash}`))
    return new Response(JSON.stringify(header), { status: header == null ? 404 : 200 })
  })
  const observer = jest.fn(() => {
    throw new Error('observer failed')
  })
  const { client } = harness([], { fetch: fetcher as typeof fetch, onStreamError: observer })
  let finish!: () => void
  const delivered = new Promise<void>(resolve => {
    finish = resolve
  })
  const listener = jest.fn(() => {
    if (listener.mock.calls.length === 2) finish()
  })
  const id = await client.subscribeReorgs(listener)
  try {
    await delivered
    expect(listener.mock.calls).toEqual([
      [2, oldTip, newTip, [oldTip, parent]],
      [2, oldTip, newTip, [oldTip, parent]]
    ])
    expect(client.streamErrorCount).toBe(1)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.map(call => String(call[0]).split('/v2')[1])).toEqual([
      '/reorg/stream',
      `/header/hash/${oldTip.hash}`,
      `/header/hash/${parent.hash}`
    ])
  } finally {
    await client.unsubscribe(id)
  }
})
