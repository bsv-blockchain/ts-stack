import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { purchaseCoordinatorFixture } from './private-purchase-coordinator.fixture.js'
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

it('retains original covenant obligations and first private result across generated native interruptions', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        mode: fc.integer({ min: 0, max: 4 }),
        restart: fc.boolean(),
        late: fc.boolean(),
        retries: fc.integer({ min: 0, max: 2 }),
        withdrawn: fc.boolean()
      }),
      async schedule => {
        const f = purchaseCoordinatorFixture()
        try {
          await f.prepare()
          const original = f.current()!.custody.original
          if (schedule.restart) await f.reopen()
          if (schedule.withdrawn) f.setAvailable(false)
          if (schedule.mode === 4) {
            f.f.setNow(original.terms.body.recoveryUntil)
            await f.recover()
            expect(f.current()!.progress).toMatchObject({ status: 'expired', txid: null })
            expect(f.counts.admission).toBe(0)
            expect(f.counts.issue).toBe(0)
          } else {
            if (schedule.mode === 1) f.setAdmitted(false)
            if (schedule.mode === 2) f.setRelease(false)
            if (schedule.mode === 3) f.setIssue(false)
            if (schedule.mode === 3) await expect(f.submit()).rejects.toThrow('issuer unavailable')
            else await f.submit()
            const operation = f.current()!.progress.operationId
            if (schedule.restart) await f.reopen()
            if (schedule.late) f.f.setNow('100000')
            f.setAdmitted(true)
            f.setRelease(true)
            f.setIssue(true)
            await f.recover()
            const exact = f.projected()
            for (let attempt = 0; attempt < schedule.retries; attempt++) await f.recover()
            expect(f.current()!.progress).toMatchObject({
              status: 'delivered',
              operationId: operation,
              txid: f.f.candidate.txid,
              admission: { acceptedAt: '20' }
            })
            expect(f.projected()).toEqual(exact)
            expect(f.counts.potatoes).toBe(1)
          }
          expect(f.current()!.custody.original).toEqual(original)
          expect(f.counts.prepare).toBe(1)
          expect(f.counts.terms).toBe(1)
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)

it('keeps one commitment and one private delivery through 300 current-owner recovery histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        pending: fc.constantFrom('admission', 'release', 'issuance'),
        restart: fc.boolean(),
        late: fc.boolean(),
        retries: fc.integer({ min: 0, max: 2 })
      }),
      async schedule => {
        const f = purchaseCoordinatorFixture(
          {},
          purchaseStoreFixture({}, 'native-observation-v1', 'full-purchase-commitment-v1')
        )
        try {
          await f.prepare()
          if (schedule.pending === 'admission') f.setAdmitted(false)
          if (schedule.pending === 'release') f.setRelease(false)
          if (schedule.pending === 'issuance') f.setIssue(false)
          if (schedule.pending === 'issuance')
            await expect(f.submit()).rejects.toThrow('issuer unavailable')
          else await f.submit()
          const original = structuredClone(f.current()!.custody.original),
            operationId = f.current()!.progress.operationId
          expect(f.current()!.progress.purchaseCommitment).toBe(f.f.purchaseCommitment)
          if (schedule.restart) await f.reopen()
          if (schedule.late) f.f.setNow('100000')
          f.setAdmitted(true)
          f.setRelease(true)
          f.setIssue(true)
          await f.recover()
          const exact = f.projected()
          for (let i = 0; i < schedule.retries; i++) await f.recover()
          expect(f.projected()).toEqual(exact)
          expect(f.current()!.custody.original).toEqual(original)
          expect(f.current()!.progress).toMatchObject({
            status: 'delivered',
            operationId,
            purchaseCommitment: f.f.purchaseCommitment
          })
          expect(exact).toHaveProperty(
            'result.potatoes.body.purchaseCommitment',
            f.f.purchaseCommitment
          )
          expect(f.counts.potatoes).toBe(1)
          expect(f.counts.terms).toBe(1)
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)
