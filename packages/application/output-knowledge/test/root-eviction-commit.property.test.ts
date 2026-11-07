import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { rootCommitContext } from '../src/root-eviction/RootEvictionCommitContext.js'

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

it('requires current access, installed policy and context for every exact U64 observation', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 18446744073709551615n }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (instant, access, samePolicy, current) => {
        const calls: string[] = []
        const read = () =>
          rootCommitContext(
            { revision: '17', policyDigest: '11'.repeat(32) },
            {
              expectedPolicyDigest: (samePolicy ? '11' : '22').repeat(32),
              clock: () => {
                calls.push('clock')
                return instant.toString()
              },
              authorize: (head, now) => {
                calls.push('access')
                expect(head).toEqual({ revision: '17', policyDigest: '11'.repeat(32) })
                expect(now).toBe(instant.toString())
                return access
              },
              contextCurrent: (_head, now) => {
                calls.push('context')
                expect(now).toBe(instant.toString())
                return current
              }
            }
          )
        if (!access) expect(read).toThrow(expect.objectContaining({ code: 'not-found' }))
        else if (!samePolicy || !current)
          expect(read).toThrow(expect.objectContaining({ code: 'context-changed' }))
        else expect(read()).toBe(instant.toString())
        expect(calls).toEqual(
          access && samePolicy ? ['clock', 'access', 'context'] : ['clock', 'access']
        )
      }
    )
  )
})
