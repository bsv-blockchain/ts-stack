import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import type { PrivateAcquisitionEvent } from '../src/private/PrivateAcquisitionProgress.js'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'
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
it('preserves original obligations and exactly one result through generated native restart histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        stop: fc.integer({ min: 0, max: 5 }),
        restart: fc.boolean(),
        late: fc.boolean(),
        rejected: fc.boolean(),
        size: fc.integer({ min: 0, max: 128 })
      }),
      async schedule => {
        const f = await acquisitionStoreFixture()
        try {
          let owner = f.owner,
            state = f.quote()
          const receiptTime = schedule.late ? 101 : 30
          for (let step = 1; step <= schedule.stop; step++) {
            f.setNow(String(receiptTime + step))
            if (schedule.restart) owner = f.open()
            let event: PrivateAcquisitionEvent
            if (step === 1) event = { type: 'pin', payment: f.f.f.payment() }
            else if (step === 2)
              event = {
                type: 'reserve-funding',
                candidateDigest: state.state.progress.candidate!.digest,
                sellerPaymentKey: f.f.f.sellerPaymentKey,
                acceptance: {
                  chain: f.f.f.chain,
                  txid: f.f.f.transaction.id('hex'),
                  policy: { kind: 'local-admission' },
                  acceptedAt: '19'
                }
              }
            else if (step === 3 && schedule.rejected)
              event = {
                type: 'wallet-rejected',
                operationId: state.state.progress.funding!.operation.id,
                reason: 'definitive-local-rejection'
              }
            else if (step === 3)
              event = { type: 'wallet-accepted', receipt: f.f.f.receipt(state.state.progress) }
            else event = { type: 'prepare-delivery' }
            if (step === 5)
              state = owner.store.complete(
                f.id,
                f.buyer,
                state.row.revision,
                Buffer.alloc(schedule.size, 57).toString('base64'),
                f.clock,
                f.guard
              )
            else
              state = owner.store.advance(
                f.id,
                f.buyer,
                state.row.revision,
                event as Exclude<PrivateAcquisitionEvent, { type: 'delivered' }>,
                f.clock,
                f.guard
              )
            expect(f.open().store.load(f.id, f.buyer, f.clock, f.guard)?.state).toEqual(state.state)
            if (state.state.progress.phase === 'failed') break
          }
          const expected =
            schedule.rejected && schedule.stop >= 3
              ? 'failed'
              : ['quoted', 'quoted', 'funding-pending', 'funded', 'delivery-pending', 'delivered'][
                  schedule.stop
                ]
          expect(state.state.progress.phase).toBe(expected)
          let response: ReturnType<typeof owner.store.load>
          response = f.open().store.load(f.id, f.buyer, f.clock, f.guard)
          expect(response?.original).toEqual(f.original)
          let sent = 0
          owner.store.disclose(state, f.buyer, f.clock, f.guard, value => {
            sent++
            expect(value.status).toBe(expected)
            expect(value.challenge).toEqual(f.original.challenge)
            expect(value.result?.context).toBe(
              expected === 'delivered'
                ? Buffer.alloc(schedule.size, 57).toString('base64')
                : undefined
            )
            expect(Object.hasOwn(value, 'walletReceipt')).toBe(false)
          })
          expect(sent).toBe(1)
          expect(owner.store.quote(f.original, 'Ag==', f.clock, f.guard).state).toEqual(state.state)
          expect(
            owner.domain.ledger.enumerate('funding-fence', null, 64, f.clock, f.guard).entries
          ).toHaveLength(1)
          if (schedule.stop >= 1) {
            f.setNow('999999')
            expect(
              owner.store.advance(
                f.id,
                f.buyer,
                state.row.revision,
                { type: 'pin', payment: f.f.f.payment() },
                f.clock,
                f.guard
              ).state
            ).toEqual(state.state)
          }
        } finally {
          f.dispose()
        }
      }
    )
  )
}, 180000)
