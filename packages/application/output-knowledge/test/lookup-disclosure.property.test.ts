import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { providerFixture } from './lookup-provider-fixture.js'

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

it('serializes generated block/release histories and accepts only the exact matching external operation', async () => {
  const f = await providerFixture()
  const id = 'model-guard'
  await f.sessions.initializeGuard(id)
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async changes => {
        let revision = BigInt(await f.sessions.guard(id))
        for (let step = 0; step < changes.length; step++) {
          if (changes[step]) {
            const operation = (step + 1).toString(16).padStart(64, '0')
            const blocked = await f.sessions.blockGuard(id, revision.toString(), operation)
            expect(blocked).toBe((revision + 1n).toString())
            expect(await f.sessions.blockGuard(id, revision.toString(), operation)).toBe(blocked)
            await expect(
              f.sessions.releaseGuard(id, blocked, 'ff'.repeat(32))
            ).rejects.toMatchObject({ code: 'conflict' })
            expect(await f.sessions.guardState(id)).toEqual({
              revision: blocked,
              blocked: true,
              operation
            })
            const released = await f.sessions.releaseGuard(id, blocked, operation)
            expect(released).toBe((revision + 2n).toString())
            expect(await f.sessions.releaseGuard(id, blocked, operation)).toBe(released)
            revision += 2n
          } else {
            const next = await f.sessions.advanceGuard(id, revision.toString())
            revision++
            expect(next).toBe(revision.toString())
          }
          expect(await f.sessions.guard(id)).toBe(revision.toString())
          expect((await f.sessions.guardState(id)).blocked).toBe(false)
        }
      })
    )
  } finally {
    await f.cleanup()
  }
}, 120000)
