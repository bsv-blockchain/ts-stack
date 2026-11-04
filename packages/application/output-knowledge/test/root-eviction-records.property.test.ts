import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { outputRootAdvertisementDigest } from '@bsv/sdk'
import { clock, fixture, request, requester, signed } from './root-eviction-fixture.js'

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
  'retains partial-batch outcomes and remaining expiry across proof-preserving retries and restart',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.nat(1000000),
          count: fc.integer({ min: 2, max: 4 }),
          accept: fc.boolean(),
          eligible: fc.boolean()
        }),
        async step => {
          const f = await fixture()
          try {
            const body = request(`partial_generated_${step.id}`)
            body.targets = Array.from({ length: step.count }, (_, index) => {
              const target = structuredClone(body.targets[0])
              target.outpoint.txid = index.toString(16).padStart(64, '0')
              target.advertisement.txid = target.outpoint.txid
              target.advertisementDigest = outputRootAdvertisementDigest({
                service: target.service,
                outpoint: target.outpoint,
                lockingScript: 'UQ=='
              })
              return target
            })
            const retained = await f.store.retain(signed(body), requester, clock)
            await f.store.evaluate({
              requestDigest: retained.digest,
              expectedRevision: '0',
              now: '150',
              targets: [
                {
                  index: 0,
                  disposition: step.accept ? 'accept' : 'reject',
                  reasonCode: 'reviewed',
                  eligible: step.eligible
                }
              ]
            })
            const first = await f.store.result(requester, body.requestId, '150')
            expect(first.outcomes[0]).toMatchObject({
              actionStatus: step.accept ? 'applied' : 'rejected',
              revision: '1'
            })
            expect(
              first.outcomes
                .slice(1)
                .every(item => item.actionStatus === 'pending' && item.revision === '0')
            ).toBe(true)
            const reopened = f.reopen()
            expect(
              await reopened.retain(signed(body), requester, { ...clock, now: '200' })
            ).toEqual(retained)
            const expired = await reopened.result(requester, body.requestId, '200')
            expect(expired.outcomes[0]).toEqual(first.outcomes[0])
            expect(
              expired.outcomes
                .slice(1)
                .every(
                  item =>
                    item.actionStatus === 'rejected' &&
                    item.reasonCode === 'request-expired' &&
                    item.revision === '2' &&
                    item.affectedDecisionIds.length === 0
                )
            ).toBe(true)
            const replay = await reopened.result(requester, body.requestId, '201')
            expect(replay.outcomes).toEqual(expired.outcomes)
            expect((await reopened.head()).revision).toBe('2')
            expect(await reopened.projections(10)).toHaveLength(step.accept ? 1 : 0)
            const changed = structuredClone(body)
            changed.reason += '-changed'
            await expect(reopened.retain(signed(changed), requester, clock)).rejects.toMatchObject({
              code: 'conflict',
              message: expect.stringMatching(/\S/)
            })
          } finally {
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
