import fc from 'fast-check'
import { StorageAccessQueue } from './StorageAccessQueue'
import { StorageAccessCancelledError } from './StorageAccessCancelledError'
import { StorageAccessQueueLimitError } from './StorageAccessQueueLimitError'

const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : 300,
  seed: Number.isSafeInteger(seed) ? seed : 3242026,
  ...(path === undefined || path === '' ? {} : { path })
})

test('generated overload and cancellations preserve admitted FIFO, exclusive ownership and future admission', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 32 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }),
      fc.constantFrom('foreground', 'background'),
      async (maximum, cancellations, priority) => {
        const queue = new StorageAccessQueue(maximum),
          owner = await queue.acquire('exclusive')
        const controllers = cancellations.map(() => new AbortController()),
          observed: number[] = [],
          rejected: number[] = []
        let active = 0
        const requests = controllers.map((controller, index) =>
          queue.acquire('exclusive', priority, controller.signal).then(
            async release => {
              try {
                expect(active).toBe(0)
                active++
                observed.push(index)
                await Promise.resolve()
                expect(active).toBe(1)
              } finally {
                active--
                release()
                release()
              }
            },
            cause => {
              rejected.push(index)
              if (index >= maximum) expect(cause).toBeInstanceOf(StorageAccessQueueLimitError)
              else {
                expect(cancellations[index]).toBe(true)
                expect(cause).toBeInstanceOf(StorageAccessCancelledError)
                expect(cause.signal).toBe(controller.signal)
                expect(cause.cause).toBe(controller.signal.reason)
              }
            }
          )
        )
        try {
          controllers.forEach((controller, index) => {
            if (cancellations[index]) controller.abort(new Error('generated queue cancellation'))
          })
          expect(observed).toEqual([])
        } finally {
          owner()
        }
        await Promise.all(requests)
        const admitted = cancellations
          .map((_value, index) => index)
          .filter(index => index < maximum && !cancellations[index])
        expect(observed).toEqual(admitted)
        expect(rejected.slice().sort((a, b) => a - b)).toEqual(
          cancellations.map((_value, index) => index).filter(index => !admitted.includes(index))
        )
        expect(active).toBe(0)
        const next = await queue.acquire('exclusive')
        next()
      }
    ),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
}, 180000)
