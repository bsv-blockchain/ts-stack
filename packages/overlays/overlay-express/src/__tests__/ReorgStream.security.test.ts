import { describe, expect, it, jest } from '@jest/globals'
import { extractSseFrames, parseReorgEvent, ReorgSseAdapter } from '../ReorgStream.js'

const HASH_A = 'aa'.repeat(32)

const validEvent = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    orphanedHashes: [HASH_A],
    commonAncestor: { height: 4 },
    newTip: { height: 5 },
    depth: 1,
    ...overrides
  })

const validOptions = (): ConstructorParameters<typeof ReorgSseAdapter>[0] => ({
  url: 'https://chaintracks.example/v2/reorg/stream',
  onReorg: async () => {},
  fetchImpl: jest.fn<typeof fetch>()
})

describe('reorg stream hostile boundaries', () => {
  it.each([
    { orphanedHashes: [HASH_A, HASH_A.toUpperCase()] },
    { orphanedHashes: 'not-an-array' },
    { orphanedHashes: [null] },
    { orphanedHashes: ['not-a-hash'] },
    { orphanedHashes: [`x${HASH_A}`] },
    { orphanedHashes: [`${HASH_A}x`] },
    { commonAncestor: { height: 6 } },
    { commonAncestor: null, depth: -1 },
    { commonAncestor: null, depth: Number.MAX_SAFE_INTEGER + 1 },
    { newTip: { height: -1 } }
  ])('rejects a malformed reorg claim %#', override => {
    expect(parseReorgEvent(validEvent(override))).toBeNull()
  })

  it('rejects an oversized orphan claim before iterating its values', () => {
    expect(
      parseReorgEvent(validEvent({ orphanedHashes: Array.from({ length: 10_001 }, () => HASH_A) }))
    ).toBeNull()
  })

  it('accepts the exact orphan-claim limit', () => {
    const orphanedHashes = Array.from({ length: 10_000 }, (_, index) =>
      index.toString(16).padStart(64, '0')
    )
    expect(parseReorgEvent(validEvent({ orphanedHashes }))).toMatchObject({
      orphanedBlockHashes: orphanedHashes
    })
  })

  it('bounds complete frames and the number of events per read', () => {
    expect(() => extractSseFrames(`data: ${'a'.repeat(1024 * 1024)}\n\n`)).toThrow('frame exceeds')
    expect(() => extractSseFrames('data: {}\n\n'.repeat(1001))).toThrow('too many events')
  })

  it('accepts exact frame and event-count limits and preserves data spacing', () => {
    expect(extractSseFrames(`${'x'.repeat(1024 * 1024)}\n\n`)).toEqual({ events: [], rest: '' })
    expect(extractSseFrames('data: {}\n\n'.repeat(1000)).events).toHaveLength(1000)
    expect(extractSseFrames('data:x\n\ndata: x\n\n').events).toEqual(['x', 'x'])
    expect(extractSseFrames('x'.repeat(1024 * 1024))).toEqual({
      events: [],
      rest: 'x'.repeat(1024 * 1024)
    })
  })

  it.each([
    [{ onReorg: undefined }, 'onReorg must be a function'],
    [{ onConnect: 'bad' }, 'onConnect must be a function'],
    [{ fetchImpl: 'bad' }, 'fetchImpl must be a function'],
    [{ allowPrivateHosts: 'yes' }, 'allowPrivateHosts must be a boolean'],
    [{ logger: {} }, 'logger must implement log, warn, and error'],
    [{ reconnectDelayMs: -1 }, 'reconnectDelayMs'],
    [{ reconnectDelayMs: 3_600_001 }, 'reconnectDelayMs'],
    [{ connectTimeoutMs: 0 }, 'connectTimeoutMs'],
    [{ connectTimeoutMs: 300_001 }, 'connectTimeoutMs'],
    [{ idleTimeoutMs: 0 }, 'idleTimeoutMs'],
    [{ idleTimeoutMs: 3_600_001 }, 'idleTimeoutMs']
  ])('rejects hostile adapter configuration %#', (override, message) => {
    expect(() => new ReorgSseAdapter({ ...validOptions(), ...override } as any)).toThrow(message)
  })

  it('accepts exact timeout boundaries and a complete logger', () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    for (const reconnectDelayMs of [0, 3_600_000]) {
      for (const connectTimeoutMs of [1, 300_000]) {
        for (const idleTimeoutMs of [1, 3_600_000]) {
          expect(
            () =>
              new ReorgSseAdapter({
                ...validOptions(),
                allowPrivateHosts: false,
                logger,
                reconnectDelayMs,
                connectTimeoutMs,
                idleTimeoutMs
              })
          ).not.toThrow()
        }
      }
    }
  })

  it.each(['log', 'warn', 'error'] as const)('requires logger.%s', missingMethod => {
    const logger: Record<string, unknown> = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    delete logger[missingMethod]
    expect(() => new ReorgSseAdapter({ ...validOptions(), logger } as any)).toThrow(
      'logger must implement log, warn, and error'
    )
  })

  it('rejects missing bodies and unexpected response media types', async () => {
    const missingBody = new ReorgSseAdapter({
      ...validOptions(),
      fetchImpl: jest.fn<typeof fetch>(async () => new Response(null, { status: 503 }))
    })
    await expect((missingBody as any).connectOnce()).rejects.toThrow('responded 503')

    const wrongMedia = new ReorgSseAdapter({
      ...validOptions(),
      fetchImpl: jest.fn<typeof fetch>(
        async () => new Response('data: {}\n\n', { headers: { 'content-type': 'text/plain' } })
      )
    })
    await expect((wrongMedia as any).connectOnce()).rejects.toThrow('not text/event-stream')

    for (const contentType of ['xtext/event-stream', 'text/event-streamx']) {
      const misleadingMedia = new ReorgSseAdapter({
        ...validOptions(),
        fetchImpl: jest.fn<typeof fetch>(
          async () => new Response('data: {}\n\n', { headers: { 'content-type': contentType } })
        )
      })
      await expect((misleadingMedia as any).connectOnce()).rejects.toThrow('not text/event-stream')
    }
  })

  it('sanitizes control characters before logging connection failures', async () => {
    let adapter: ReorgSseAdapter
    const warn = jest.fn<typeof console.warn>(() => {
      adapter.stop()
    })
    const logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn
    }
    adapter = new ReorgSseAdapter({
      ...validOptions(),
      logger,
      fetchImpl: jest.fn<typeof fetch>(async () => {
        throw new Error('first line\nsecond line')
      })
    })

    await expect((adapter as any).runLoop()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[BASM] reorg stream error: "first line second line"')
  })

  it('runs catch-up before accepting a correlated reorg event', async () => {
    const calls: string[] = []
    const onReorg = jest.fn(async (_input: unknown) => {
      calls.push('reorg')
    })
    const adapter = new ReorgSseAdapter({
      ...validOptions(),
      onConnect: async () => {
        calls.push('connect')
      },
      onReorg,
      fetchImpl: jest.fn<typeof fetch>(
        async () =>
          new Response(`data: ${validEvent()}\n\n`, {
            headers: { 'content-type': 'text/event-stream; charset=utf-8' }
          })
      )
    })

    await expect((adapter as any).connectOnce()).resolves.toBeUndefined()
    expect(calls).toEqual(['connect', 'reorg'])
    expect(onReorg).toHaveBeenCalledWith({
      orphanedBlockHashes: [HASH_A],
      rebuildFromHeight: 5,
      newTipHeight: 5
    })
  })

  it('rejects malformed events and oversized transport chunks before callbacks', async () => {
    const onReorg = jest.fn(async () => {})
    const adapter = new ReorgSseAdapter({ ...validOptions(), onReorg })

    await expect((adapter as any).processReorgFrame('{}')).rejects.toThrow('malformed reorg frame')
    expect(onReorg).not.toHaveBeenCalled()

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
        controller.close()
      }
    })
    await expect((adapter as any).pumpEvents(stream.getReader())).rejects.toThrow(
      'chunk exceeds the configured limit'
    )
  })

  it('times out an idle reader and lets stop release a reconnect delay', async () => {
    const adapter = new ReorgSseAdapter({ ...validOptions(), idleTimeoutMs: 5 })
    const stream = new ReadableStream<Uint8Array>({ start() {} })
    await expect((adapter as any).readWithIdleDeadline(stream.getReader())).rejects.toThrow(
      'idle timeout after 5ms'
    )

    const delayed = (adapter as any).delay(60_000) as Promise<void>
    adapter.stop()
    await expect(delayed).resolves.toBeUndefined()
  })
})
