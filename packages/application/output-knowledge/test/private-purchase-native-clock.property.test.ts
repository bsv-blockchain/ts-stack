import { expect, it, jest } from '@jest/globals'
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

it('preserves original custody through 300 clock-advancing native write and interruption histories', () => {
  fc.assert(
    fc.property(
      fc.record({
        stop: fc.integer({ min: 0, max: 3 }),
        restarts: fc.integer({ min: 0, max: 15 }),
        rejection: fc.boolean(),
        deliveryFailure: fc.boolean(),
        expire: fc.boolean(),
        elapsed: fc.integer({ min: 1, max: 3 })
      }),
      schedule => {
        const f = purchaseStoreFixture({}, 'native-observation-v1')
        try {
          function elapsedWrite(owner: typeof f.owner) {
            const original = owner.domain.ledger.commitPrepared.bind(owner.domain.ledger)
            jest.spyOn(owner.domain.ledger, 'commitPrepared').mockImplementation((...args) => {
              f.setNow(String(BigInt(f.clock()) + BigInt(schedule.elapsed)))
              return original(...args)
            })
          }
          elapsedWrite(f.owner)
          let owner = f.owner,
            state = f.prepare()
          const original = structuredClone(state.custody)
          expect(state.progress.createdAt).toBe(String(20 + schedule.elapsed))
          expect(state.state.clockProfile).toBe('native-observation-v1')
          expect(original.original.terms).toEqual(f.custody.original.terms)
          function restart(step: number) {
            if ((schedule.restarts & (1 << step)) !== 0) {
              f.close(owner.domain)
              owner = f.open()
              elapsedWrite(owner)
            }
            const retained = owner.store.load(f.id, f.buyer, f.clock, f.guard)!
            expect(retained.state).toEqual(state.state)
            expect(retained.custody).toEqual(original)
            state = retained
          }
          restart(0)
          function pin() {
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
          }
          function admit() {
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
          }
          function deliver() {
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
          function expectedStatus() {
            if (schedule.expire) return 'expired'
            if (schedule.stop >= 2 && schedule.rejection) return 'admission-rejected'
            if (schedule.stop === 3 && schedule.deliveryFailure) return 'delivery-failed'
            return ['prepared', 'admission-pending', 'admitted-delivery-pending', 'delivered'][
              schedule.stop
            ]
          }
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
            pin()
            if (schedule.stop >= 2) {
              admit()
              if (!schedule.rejection && schedule.stop >= 3) deliver()
            }
          }
          const expected = expectedStatus()
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
