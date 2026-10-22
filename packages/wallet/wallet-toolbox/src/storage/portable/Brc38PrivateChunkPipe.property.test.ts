import fc from 'fast-check'
let Brc38PrivateChunkPipe: typeof import('./Brc38PrivateChunkPipe').Brc38PrivateChunkPipe
beforeAll(async () => {
  Brc38PrivateChunkPipe = (await import('./Brc38PrivateChunkPipe')).Brc38PrivateChunkPipe
})

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

test('300 bounded private producer/reader schedules preserve exact bytes and owned backpressure', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 128 }), fc.integer({ min: 1, max: 16 }), async (bytes, width) => {
      const pipe = new Brc38PrivateChunkPipe(width),
        received: number[] = []
      const reader = (async () => {
        for await (const chunk of pipe) {
          expect(chunk.byteLength).toBeLessThanOrEqual(width)
          received.push(...chunk)
        }
      })()
      const writer = (async () => {
        async function* operations() {
          if (bytes.length === 0) yield pipe.append(bytes)
          for (let offset = 0; offset < bytes.length; offset += width)
            yield pipe.append(bytes.subarray(offset, offset + width))
        }
        for await (const result of operations()) expect(result).toBeUndefined()
        pipe.end()
      })()
      await Promise.all([reader, writer])
      expect(received).toEqual([...bytes])
    }),
    {
      numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
