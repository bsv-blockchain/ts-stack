import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { proposalSendFixture } from './proposal-send-fixture.js'

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
  'enqueues only the exact still-selected record under current access across restart and concurrent updates',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          update: fc.boolean(),
          historical: fc.boolean(),
          authorized: fc.boolean(),
          restart: fc.boolean()
        }),
        async schedule => {
          const f = await proposalSendFixture()
          try {
            if (schedule.update) await f.open().commit(f.next)
            if (schedule.restart) await f.store.close()
            const store = schedule.restart ? f.open() : f.store
            let queued = 0
            const result = await Promise.allSettled([
              store.enqueueResponse(
                {
                  reference: schedule.historical ? f.proposal : f.channel,
                  bytes: f.bytes
                },
                entry =>
                  schedule.authorized &&
                  canonicalOutputJSON(entry?.transition.next) === canonicalOutputJSON(f.first.next),
                bytes => {
                  expect(bytes).toEqual(f.bytes)
                  queued += 1
                  return undefined
                }
              )
            ])
            const permitted = schedule.authorized && (schedule.historical || !schedule.update)
            expect(result[0].status).toBe(permitted ? 'fulfilled' : 'rejected')
            expect(queued).toBe(permitted ? 1 : 0)
            expect((await store.head()).revision).toBe(schedule.update ? '2' : '1')
          } finally {
            await f.close()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(30000, propertyRuns * 100))
)
