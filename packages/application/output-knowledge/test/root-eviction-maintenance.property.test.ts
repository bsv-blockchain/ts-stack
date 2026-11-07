import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { SQLiteRootEvictionMaintenance } from '../src/root-eviction/SQLiteRootEvictionMaintenance.js'
import { fixture, request, requester, signed, clock } from './root-eviction-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it(
  'recovers bounded generated pending scans and preserves exact expiry/retry histories after restart',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3 }),
        fc.nat(1000000),
        fc.boolean(),
        async (count, maximum, id, reopen) => {
          const f = await fixture()
          let worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
          try {
            const pending = []
            for (let index = 0; index < count; index++)
              pending.push(
                await f.store.retain(
                  signed(request(`generated_maintenance_${id}_${index}`)),
                  requester,
                  clock
                )
              )
            if (reopen) {
              await worker.close()
              worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
            }
            const guard = { clock: () => '200', authorize: () => true }
            let after: string | undefined
            const seen: string[] = []
            do {
              const page = await worker.pendingPage({ maximum, after }, guard)
              expect(page.value.digests.length).toBeLessThanOrEqual(maximum)
              for (const digest of page.value.digests) {
                seen.push(digest)
                const expired = await worker.expirePending(digest, guard)
                expect(expired.value).toEqual({ expiredTargets: [0], pendingTargets: [] })
                const retried = await worker.expirePending(digest, guard)
                expect(retried.value).toEqual({ expiredTargets: [], pendingTargets: [] })
                expect(retried.head).toEqual(expired.head)
              }
              after = page.value.next
            } while (after !== undefined)
            expect(seen).toEqual(pending.map(record => record.digest).sort())
            expect((await worker.pendingPage({ maximum }, guard)).value).toEqual({ digests: [] })
            expect((await f.store.head()).revision).toBe(String(count))
            for (const original of pending) {
              expect(await f.store.get(requester, original.request.body.requestId)).toEqual(
                original
              )
              const result = await f.store.result(requester, original.request.body.requestId, '201')
              expect(result.outcomes[0]).toMatchObject({
                actionStatus: 'rejected',
                reasonCode: 'request-expired',
                affectedDecisionIds: []
              })
            }
          } finally {
            await worker.close()
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
