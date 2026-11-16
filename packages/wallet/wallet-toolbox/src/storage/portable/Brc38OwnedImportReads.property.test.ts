import fc from 'fast-check'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

describe('owned private preparation read interleavings', () => {
  test('every pending success/failure is drained and escaped work cannot restart ownership', async () => {
    const active = new Set<Promise<void>>()
    try {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer(), async (readFails, callbackFails, value) => {
          const work = (async () => {
            const scope = new Brc38OwnedImportReads(),
              readCause = new Error('Synthetic read'),
              callbackCause = new Error('Synthetic callback')
            let open!: () => void,
              enter!: () => void,
              drained = false,
              finished = false
            const held = new Promise<void>(resolve => {
                open = resolve
              }),
              entered = new Promise<void>(resolve => {
                enter = resolve
              })
            const operation = scope
              .retain(async () => {
                void scope.run(async () => {
                  enter()
                  await held
                  drained = true
                  if (readFails) throw readCause
                  return value
                })
                if (callbackFails) throw callbackCause
                return value
              })
              .then(
                result => ({ result, failure: undefined }),
                failure => ({ result: undefined, failure })
              )
            void operation.then(() => {
              finished = true
            })
            await entered
            expect(finished).toBe(false)
            const escaped = jest.fn()
            await expect(scope.run(escaped)).rejects.toThrow('unavailable')
            expect(escaped).not.toHaveBeenCalled()
            open()
            const observed = await operation
            expect(drained).toBe(true)
            if (readFails && callbackFails)
              expect(observed.failure).toMatchObject({ errors: [callbackCause, readCause] })
            else if (readFails) expect(observed.failure).toBe(readCause)
            else if (callbackFails) expect(observed.failure).toBe(callbackCause)
            else expect(observed).toEqual({ result: value, failure: undefined })
            await expect(scope.run(escaped)).rejects.toThrow('unavailable')
            expect(escaped).not.toHaveBeenCalled()
          })()
          active.add(work)
          try {
            await work
          } finally {
            active.delete(work)
          }
        }),
        {
          numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
          seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
          path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
          interruptAfterTimeLimit: 150000,
          markInterruptAsFailure: true
        }
      )
    } finally {
      await Promise.allSettled(active)
    }
  }, 180000)
})
