import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import type { OutputPurchaseEnvelope } from '@bsv/sdk'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

it('preserves one original transaction and exact private result through 300 native interruption histories', () => {
  fc.assert(
    fc.property(
      fc.record({
        stop: fc.integer({ min: 0, max: 3 }),
        restarts: fc.integer({ min: 0, max: 15 }),
        rejection: fc.boolean(),
        deliveryFailure: fc.boolean(),
        expire: fc.boolean()
      }),
      schedule => {
        const f = purchaseStoreFixture()
        try {
          let owner = f.owner,
            state = f.prepare()
          const original = structuredClone(state.custody)
          function restart(step: number) {
            if ((schedule.restarts & (1 << step)) !== 0) {
              f.close(owner.domain)
              owner = f.open()
            }
            const retained = owner.store.load(f.id, f.buyer, f.clock, f.guard)!
            expect(retained.state).toEqual(state.state)
            expect(retained.custody).toEqual(original)
            state = retained
          }
          restart(0)
          if (schedule.expire) {
            f.setNow('86500')
            state = owner.store.advance(
              f.id,
              f.buyer,
              state.row.revision,
              { type: 'expire' },
              f.clock,
              f.guard
            )
          } else if (schedule.stop >= 1) {
            f.setNow('29')
            const before = state
            state = owner.store.pin(
              f.id,
              f.buyer,
              state.row.revision,
              f.candidate,
              f.clock,
              f.guard
            )
            expect(() =>
              owner.store.pin(f.id, f.buyer, before.row.revision, f.candidate, f.clock, f.guard)
            ).toThrow(expect.objectContaining({ code: 'conflict' }))
            restart(1)
            expect(state.candidate).toEqual(f.candidate)
            expect(() =>
              owner.store.pin(
                f.id,
                f.buyer,
                state.row.revision,
                { ...f.candidate, txid: '66'.repeat(32) },
                f.clock,
                f.guard
              )
            ).toThrow(expect.objectContaining({ code: 'conflict' }))
            if (schedule.stop >= 2) {
              f.setNow('31')
              state = owner.store.advance(
                f.id,
                f.buyer,
                state.row.revision,
                schedule.rejection
                  ? { type: 'admission-rejected', reason: 'Local topic refusal', evidence: 'AA==' }
                  : {
                      type: 'admitted',
                      steak: f.f.steak,
                      acceptedAt: '30',
                      assessmentContextId: 'fixture-view'
                    },
                f.clock,
                f.guard
              )
              restart(2)
              if (!schedule.rejection && schedule.stop >= 3) {
                f.setNow('33')
                state = schedule.deliveryFailure
                  ? owner.store.advance(
                      f.id,
                      f.buyer,
                      state.row.revision,
                      { type: 'delivery-failed', reason: 'Material unavailable', evidence: 'AA==' },
                      f.clock,
                      f.guard
                    )
                  : owner.store.complete(
                      f.id,
                      f.buyer,
                      state.row.revision,
                      f.f.envelope(),
                      f.clock,
                      f.guard
                    )
                restart(3)
              }
            }
          }
          const expected = schedule.expire
            ? 'expired'
            : schedule.stop >= 2 && schedule.rejection
              ? 'admission-rejected'
              : schedule.stop === 3 && schedule.deliveryFailure
                ? 'delivery-failed'
                : ['prepared', 'admission-pending', 'admitted-delivery-pending', 'delivered'][
                    schedule.stop
                  ]
          expect(state.progress.status).toBe(expected)
          let envelope: OutputPurchaseEnvelope | undefined
          owner.store.disclose(state, f.buyer, f.clock, f.guard, result => {
            envelope = result
          })
          expect(envelope!.result.status).toBe(expected)
          if (expected === 'delivered') expect(envelope).toEqual(f.f.envelope())
          else {
            expect(envelope!.result).not.toHaveProperty('potatoes')
            expect(envelope).not.toHaveProperty('releaseEvidence')
          }
          expect(owner.store.prepare(f.custody, f.clock, f.guard).custody).toEqual(original)
          expect(
            owner.domain.ledger.enumerate('request-fence', null, 64, f.clock, f.guard).entries
          ).toHaveLength(1)
          if (state.candidate) {
            f.setNow('999999')
            expect(
              owner.store.pin(f.id, f.buyer, state.row.revision, f.candidate, f.clock, f.guard)
                .state
            ).toEqual(state.state)
          }
        } finally {
          f.dispose()
        }
      }
    )
  )
}, 180000)
