import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { parseOutputJSON, signOutputPacket, verifyOutputRootEvictionResult } from '@bsv/sdk'
import {
  rootServiceFixture,
  rootDeferred,
  rootAwaitStart
} from './root-eviction-service-fixture.js'
import { rootContractKey } from './root-contract-fixture.js'
import { policy, signed } from './root-eviction-fixture.js'

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
  'never queues an altered, cancelled, revoked or revision-stale observation over generated signing schedules',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          cancel: fc.boolean(),
          revoke: fc.boolean(),
          changePolicy: fc.boolean(),
          alterResult: fc.boolean(),
          padding: fc.integer({ min: 0, max: 4 })
        }),
        async schedule => {
          const f = await rootServiceFixture()
          const started = rootDeferred<void>(),
            physical = rootDeferred<void>(),
            abort = new AbortController()
          const queued: Uint8Array[] = []
          let running: Promise<unknown> | undefined
          try {
            f.sign.mockImplementation(async body => {
              started.resolve()
              await physical.promise
              if (schedule.alterResult) body.outcomes[0].reasonCode = 'different-observation'
              return signOutputPacket('root-eviction-result', body, rootContractKey)
            })
            const task = f
              .service()
              .submit(
                ' '.repeat(schedule.padding) + f.text,
                f.caller,
                f.selection.manifest,
                abort.signal
              )
            running = task
            void task.catch(() => {})
            await rootAwaitStart(started.promise, task)
            expect((await f.store.head()).revision).toBe('0')
            if (schedule.cancel) abort.abort()
            if (schedule.revoke) f.state.access = false
            if (schedule.changePolicy) await f.store.changePolicy('ab'.repeat(32))
            physical.resolve()
            if (schedule.cancel || schedule.alterResult) {
              await expect(task).rejects.toMatchObject({
                code: schedule.cancel ? 'cancelled' : 'invalid'
              })
            } else {
              const response = await task
              const packet = verifyOutputRootEvictionResult(
                parseOutputJSON(response.body),
                signed(f.body),
                policy
              )
              expect(packet.body.outcomes[0]).toMatchObject({
                actionStatus: 'pending',
                reasonCode: 'awaiting-local-evaluation'
              })
              expect(response.head).toEqual({ revision: '0', policyDigest: policy })
              const send = f.store.enqueue(
                {
                  revision: response.head.revision,
                  targets: [],
                  bytes: new TextEncoder().encode(response.body)
                },
                () => f.state.access,
                bytes => {
                  queued.push(bytes.slice())
                  return undefined
                }
              )
              if (schedule.revoke || schedule.changePolicy) await expect(send).rejects.toBeDefined()
              else await send
            }
            const permitted =
              !schedule.cancel &&
              !schedule.alterResult &&
              !schedule.revoke &&
              !schedule.changePolicy
            expect(queued).toHaveLength(permitted ? 1 : 0)
            expect(await f.store.projections(64)).toEqual([])
            expect((await f.store.get(f.caller.principal, f.body.requestId))?.request.body).toEqual(
              f.body
            )
          } finally {
            physical.resolve()
            await running?.catch(() => {})
            for (let step = 0; step < 20; step++) await Promise.resolve()
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
