import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { schedulerFixture } from './root-eviction-scheduler-fixture.js'
import { rootAwaitStart, rootDeferred } from './root-eviction-service-fixture.js'
import { requester } from './root-eviction-fixture.js'

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
  'retains root decisions only under current policy, access, context, time and physical ownership',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          cancel: fc.boolean(),
          revoke: fc.boolean(),
          contextChange: fc.boolean(),
          policyChange: fc.boolean(),
          expire: fc.boolean(),
          mutateObservation: fc.boolean()
        }),
        async schedule => {
          const f = await schedulerFixture(),
            started = rootDeferred<void>(),
            release = rootDeferred<void>()
          let pass: ReturnType<ReturnType<typeof f.worker>['runOnce']> | undefined
          let stopping: Promise<void> | undefined
          try {
            await f.retain()
            f.evaluate.mockImplementation(async observed => {
              if (schedule.mutateObservation) observed.head.revision = '999'
              started.resolve()
              await release.promise
              return [
                { index: 0, disposition: 'accept', eligible: true, reasonCode: 'installed-review' }
              ]
            })
            const worker = f.worker()
            pass = worker.runOnce()
            await rootAwaitStart(started.promise, pass)
            if (schedule.revoke) f.state.access = false
            if (schedule.contextChange) f.state.context = false
            if (schedule.policyChange) await f.store.changePolicy('ab'.repeat(32))
            if (schedule.expire) f.state.now = '200'
            if (schedule.cancel) stopping = worker.stop()
            release.resolve()
            const report = await pass
            await stopping
            const permitted =
              !schedule.cancel &&
              !schedule.revoke &&
              !schedule.contextChange &&
              !schedule.policyChange &&
              !schedule.expire
            const result = await f.store.result(requester, 'scheduler_request_one', f.state.now)
            expect(result.outcomes[0].actionStatus === 'applied').toBe(permitted)
            expect(await f.store.projections(64)).toHaveLength(permitted ? 1 : 0)
            if (permitted) {
              expect(report.failures).toEqual([])
              expect(result.outcomes[0]).toMatchObject({
                actionStatus: 'applied',
                reasonCode: 'installed-review'
              })
            }
          } finally {
            release.resolve()
            await pass
            await stopping
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
