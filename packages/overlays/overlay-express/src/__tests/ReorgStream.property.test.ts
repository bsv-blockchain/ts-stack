import fc from 'fast-check'

import { extractSseFrames, parseReorgEvent, ReorgSseAdapter } from '../ReorgStream.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const hashHex = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString('hex'))

function chunkText(value: string, sizes: number[]): string[] {
  const chunks: string[] = []
  let offset = 0
  let index = 0
  while (offset < value.length) {
    const size = sizes[index % sizes.length]
    chunks.push(value.slice(offset, offset + size))
    offset += size
    index += 1
  }
  return chunks
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
      } else {
        controller.close()
      }
    }
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function encodedReorgFrame(height: number): string {
  return `data: ${JSON.stringify({
    orphanedHashes: [],
    commonAncestor: { height },
    newTip: { height }
  })}\n\n`
}

describe('reorg stream parser properties', () => {
  test('normalizes arbitrary valid reorg events and honors the common ancestor', () => {
    fc.assert(
      fc.property(
        fc.array(hashHex, { maxLength: 20 }),
        fc.record({
          ancestorHeight: fc.integer({ min: 0, max: 10_000_000 }),
          tipDelta: fc.integer({ min: 0, max: 10_000_000 })
        }),
        (hashes, { ancestorHeight, tipDelta }) => {
          const newTipHeight = ancestorHeight + tipDelta
          const result = parseReorgEvent(
            JSON.stringify({
              orphanedHashes: hashes.map(hash => hash.toUpperCase()),
              commonAncestor: { height: ancestorHeight },
              newTip: { height: newTipHeight }
            })
          )

          expect(result).toEqual({
            orphanedBlockHashes: hashes,
            rebuildFromHeight: ancestorHeight + 1,
            newTipHeight
          })
        }
      )
    )

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), newTipHeight => {
        expect(
          parseReorgEvent(
            JSON.stringify({
              commonAncestor: null,
              newTip: { height: newTipHeight }
            })
          )
        ).toBeNull()
      })
    )
  })

  test('uses bounded depth fallback and rejects non-finite or fractional heights', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (newTipHeight, depth) => {
          const result = parseReorgEvent(
            JSON.stringify({
              orphanedHashes: [],
              commonAncestor: null,
              newTip: { height: newTipHeight },
              depth
            })
          )
          expect(result?.rebuildFromHeight).toBe(Math.max(0, newTipHeight - depth + 1))
        }
      )
    )

    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite),
          fc.constant(Infinity)
        ),
        invalidHeight => {
          fc.pre(!Number.isSafeInteger(invalidHeight) || invalidHeight < 0)
          expect(
            parseReorgEvent(
              JSON.stringify({
                commonAncestor: { height: 0 },
                newTip: { height: invalidHeight }
              })
            )
          ).toBeNull()
        }
      )
    )

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (newTipHeight, delta) => {
          expect(
            parseReorgEvent(
              JSON.stringify({
                commonAncestor: { height: newTipHeight + delta },
                newTip: { height: newTipHeight }
              })
            )
          ).toBeNull()
        }
      )
    )
  })

  test('extracts arbitrary complete SSE data frames and preserves the exact partial suffix', () => {
    const line = fc.string({ maxLength: 200 }).filter(value => !value.includes('\n'))
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), line, (payloads, partial) => {
        const buffer = payloads.map(payload => `data: ${payload}\n\n`).join('') + `data: ${partial}`
        expect(extractSseFrames(buffer)).toEqual({
          events: payloads,
          rest: `data: ${partial}`
        })
      })
    )
  })

  test('is total for arbitrary untrusted text frames', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), frame => {
        expect(() => parseReorgEvent(frame)).not.toThrow()
        expect(() => extractSseFrames(frame)).not.toThrow()
      })
    )
  })

  test('delivers every valid event once across arbitrary network chunk boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            ancestorHeight: fc.integer({ min: 0, max: 10_000_000 }),
            tipDelta: fc.integer({ min: 0, max: 1_000 }),
            hashes: fc.array(hashHex, { maxLength: 5 })
          }),
          { minLength: 1, maxLength: 8 }
        ),
        fc.array(fc.integer({ min: 1, max: 80 }), { minLength: 1, maxLength: 20 }),
        async (events, chunkSizes) => {
          const expected = events.map(({ ancestorHeight, tipDelta, hashes }) => ({
            orphanedBlockHashes: hashes,
            rebuildFromHeight: ancestorHeight + 1,
            newTipHeight: ancestorHeight + tipDelta
          }))
          const wire = events
            .map(({ ancestorHeight, tipDelta, hashes }) => {
              const event = {
                orphanedHashes: hashes,
                commonAncestor: { height: ancestorHeight },
                newTip: { height: ancestorHeight + tipDelta }
              }
              return `data: ${JSON.stringify(event)}\n\n`
            })
            .join('')
          const response = streamResponse(chunkText(wire, chunkSizes))
          const received: typeof expected = []
          let connections = 0
          let resolveComplete: () => void
          const complete = new Promise<void>(resolve => {
            resolveComplete = resolve
          })
          const fetchImpl = jest.fn(async () => response) as unknown as typeof fetch
          const adapter = new ReorgSseAdapter({
            url: 'https://arcade.example/reorg',
            fetchImpl,
            reconnectDelayMs: 0,
            onConnect: async () => {
              connections += 1
            },
            onReorg: async input => {
              received.push(input)
              if (received.length === expected.length) {
                adapter.stop()
                resolveComplete()
              }
            }
          })

          adapter.start()
          await complete
          adapter.start()

          expect(received).toEqual(expected)
          expect(connections).toBe(1)
          expect(fetchImpl).toHaveBeenCalledTimes(1)
        }
      )
    )
  })

  test('reconnects after HTTP and clean-stream failures while isolating malformed and failed handlers', async () => {
    const warn = jest.fn()
    const error = jest.fn()
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(
        streamResponse([`data: not-json\n\n${encodedReorgFrame(10)}${encodedReorgFrame(11)}`])
      ) as unknown as typeof fetch
    let handlerCalls = 0
    let resolveComplete: () => void
    const complete = new Promise<void>(resolve => {
      resolveComplete = resolve
    })
    const adapter = new ReorgSseAdapter({
      url: 'https://arcade.example/reorg',
      fetchImpl,
      reconnectDelayMs: 0,
      logger: { log: jest.fn(), warn, error },
      onReorg: async () => {
        handlerCalls += 1
        if (handlerCalls === 1) throw new Error('expected handler failure')
        adapter.stop()
        resolveComplete()
      }
    })

    adapter.start()
    await complete

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.flat().join(' ')).toContain('reorg stream responded 503')
    expect(warn.mock.calls.flat().join(' ')).toContain('skipping malformed reorg frame')
    expect(error.mock.calls.flat().join(' ')).toContain('expected handler failure')
  })

  test('continues event delivery when reconnect catch-up fails', async () => {
    const warn = jest.fn()
    let resolveComplete: () => void
    const complete = new Promise<void>(resolve => {
      resolveComplete = resolve
    })
    const adapter = new ReorgSseAdapter({
      url: 'https://arcade.example/reorg',
      fetchImpl: jest.fn(async () =>
        streamResponse([encodedReorgFrame(20)])
      ) as unknown as typeof fetch,
      logger: { log: jest.fn(), warn, error: jest.fn() },
      onConnect: async () => {
        throw new Error('expected catch-up failure')
      },
      onReorg: async () => {
        adapter.stop()
        resolveComplete()
      }
    })

    adapter.start()
    await complete

    expect(warn.mock.calls.flat().join(' ')).toContain('expected catch-up failure')
  })
})
