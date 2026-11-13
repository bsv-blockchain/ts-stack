import fc from 'fast-check'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})
const replay = {
  path: process.env.FAST_CHECK_PATH ?? '',
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
}

describe('physical cleanup retry ownership follows an independent completion model', () => {
  test('generated failures preserve original causes, release retry ownership and become idempotent only after success', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.array(fc.string({ maxLength: 64 }), { minLength: 1, maxLength: 4 }),
        async (failures, messages) => {
          const causes = messages.map(message => new Error(message))
          const original = [...causes]
          const attemptErrors = Array.from({ length: failures }, (_, index) => new Error(`attempt-${index}`))
          let calls = 0
          const owner = new Brc38StagingCleanupError(causes, 'generated teardown', async () => {
            const index = calls++
            if (index < failures) throw attemptErrors[index]
          })
          causes.push(new Error('later caller change'))
          expect(owner.errors).toEqual(original)
          for (const failure of attemptErrors) {
            await expect(owner.retryCleanup()).rejects.toBe(failure)
            expect(owner.errors).toEqual(original)
          }
          await expect(owner.retryCleanup()).resolves.toBeUndefined()
          expect(calls).toBe(failures + 1)
          for (let index = 0; index < 3; index++) await owner.retryCleanup()
          expect(calls).toBe(failures + 1)
          expect(owner.errors).toEqual(original)
        }
      ),
      replay
    )
  })

  test('generated concurrent retries cannot acquire a second physical owner and failed completion permits a fresh retry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.string({ maxLength: 64 }), async (failFirst, message) => {
        let release: () => void = () => {
          throw new Error('Cleanup release is not initialized')
        }
        const waiting = new Promise<void>(resolve => {
          release = resolve
        })
        const failure = new Error(message)
        let calls = 0
        let shouldFail = failFirst
        const owner = new Brc38StagingCleanupError([failure], 'generated concurrent teardown', async () => {
          calls++
          await waiting
          if (shouldFail) {
            shouldFail = false
            throw failure
          }
        })
        const first = owner.retryCleanup()
        const second = owner.retryCleanup()
        release()
        const results = await Promise.allSettled([first, second])
        expect(calls).toBe(1)
        expect(results[1].status).toBe('rejected')
        if (results[1].status === 'rejected')
          expect(results[1].reason.message).toBe('Private BRC-38 physical cleanup is already owned')
        if (failFirst) {
          expect(results[0]).toEqual({ status: 'rejected', reason: failure })
          await expect(owner.retryCleanup()).resolves.toBeUndefined()
          expect(calls).toBe(2)
        } else expect(results[0]).toEqual({ status: 'fulfilled', value: undefined })
        await expect(owner.retryCleanup()).resolves.toBeUndefined()
        expect(calls).toBe(failFirst ? 2 : 1)
        expect(owner.errors).toEqual([failure])
      }),
      replay
    )
  })
})
