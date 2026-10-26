import { test } from '@jest/globals'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { lookupSendServiceFixture } from './lookup-send-fixture.js'
const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const propertyOptions = {
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
}
fc.configureGlobal(propertyOptions)
test(
  'generated native disclosure schedules never replace current authority with a retained snapshot',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          allowed: fc.boolean(),
          cancel: fc.boolean(),
          changedBytes: fc.boolean(),
          rotated: fc.boolean(),
          guard: fc.constantFrom('same', 'advanced', 'blocked'),
          time: fc.constantFrom('before', 'at', 'after')
        }),
        async schedule => {
          const f = await lookupSendServiceFixture()
          try {
            const bound = f.disclosure.bind('open', f.response.body, f.caller)
            const expiry = BigInt(JSON.parse(f.response.body).expiresAt)
            if (schedule.rotated) await f.rotate()
            if (schedule.guard === 'advanced') await f.sessions.advanceGuard('serving', '0')
            if (schedule.guard === 'blocked')
              await f.sessions.blockGuard('serving', '0', 'dd'.repeat(32))
            f.clock.now = String(
              expiry + (schedule.time === 'before' ? -1n : schedule.time === 'at' ? 0n : 1n)
            )
            f.access.allowed = schedule.allowed
            const signal = schedule.cancel ? AbortSignal.abort() : new AbortController().signal
            const bytes = schedule.changedBytes
              ? new TextEncoder().encode('{}')
              : Buffer.from(f.bytes)
            let queued = 0,
              failed = false
            try {
              await bound.enqueue(
                bytes,
                f.caller.principal!,
                sent => {
                  assert.deepEqual(sent, f.bytes)
                  queued++
                  return undefined
                },
                signal
              )
            } catch {
              failed = true
            }
            const permitted =
              schedule.allowed &&
              !schedule.cancel &&
              !schedule.changedBytes &&
              schedule.guard === 'same' &&
              schedule.time === 'before'
            assert.equal(queued, permitted ? 1 : 0)
            assert.equal(failed, !permitted)
          } finally {
            await f.cleanup()
          }
        }
      ),
      propertyOptions
    )
  },
  Math.min(2147483647, Math.max(60000, propertyOptions.numRuns * 200))
)
