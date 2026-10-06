import { expect, test } from '@jest/globals'
import fc from 'fast-check'
import { SQLitePrivatePurchaseAliases } from '../src/private/SQLitePrivatePurchaseAliases.js'
import type { ProtectedLedgerChange } from '../src/private/ProtectedLedgerCodec.js'
import { purchaseAliasesFixture, retained } from './private-purchase-aliases.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

// Genuine ordinary file-backed encrypted native histories. This fixture uses
// disclosed toy domain/placement premises and proves custody only; it does not
// prove executable listing scripts, mined currentness or a signed License.
test('preserves original and historical custody through 300 generated native alias recovery histories', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.boolean(),
      fc.array(fc.constantFrom('late', 'owned-copy', 'original-retry', 'refuse', 'read'), {
        minLength: 1,
        maxLength: 4
      }),
      (n, rejected, history) => {
        const f = purchaseAliasesFixture(),
          cached = f.variant(n),
          selected = f.variant(n + 101)
        try {
          f.owner.reserve(f.e.original, f.clock, f.guard)
          f.put(f.e.candidate)
          f.admit(f.e.candidate)
          const address = f.e.base.owner.domain.identity.address('delivery', {
            purpose: 'alias-property-first-result-marker'
          })
          const marker: ProtectedLedgerChange = {
            ...address,
            expectedRevision: null,
            reservedBytes: 1024,
            reservedUpdates: 0,
            value: { purpose: 'storage-only-first-result', txid: f.e.candidate.txid }
          }
          retained(
            f.owner.release(f.e.original, f.e.candidate.txid, undefined, [marker], f.clock, f.guard)
          ).retain(f.clock, f.guard)
          const historical = f.read().state.historical
          f.put(cached)
          f.pending(cached)
          f.put(selected, true)
          f.pending(selected)
          if (rejected) {
            retained(
              f.owner.admission(
                f.e.original,
                selected.txid,
                {
                  status: 'rejected',
                  txid: selected.txid,
                  operationId: f.read().state.selected!.operationId,
                  reason: 'local-test-refusal',
                  evidence: ''
                },
                f.clock,
                f.guard
              )
            ).retain(f.clock, f.guard)
          } else f.admit(selected)
          const definitive = f.read().outcomes.get('selected')
          for (const step of history) {
            const opened = f.e.base.open(),
              owner = new SQLitePrivatePurchaseAliases(
                opened.domain,
                f.e.base.f.f.contracts,
                f.limits
              )
            try {
              if (step === 'late') {
                retained(
                  owner.admission(f.e.original, selected.txid, undefined, f.clock, f.guard)
                ).retain(f.clock, f.guard)
              } else if (step === 'owned-copy') {
                const copy = f.read(owner)
                copy.state.historical!.txid = 'ee'.repeat(32)
                copy.candidates.get('original')!.beef = 'AA=='
              } else if (step === 'original-retry') f.put(f.e.candidate, false, owner)
              else if (step === 'refuse') {
                f.e.base.setPermitted(false)
                expect(() => f.read(owner)).toThrow('authority changed')
                f.e.base.setPermitted(true)
              }
              const saved = f.read(owner)
              expect(saved.state.historical).toEqual(historical)
              expect(saved.candidates.get('historical')).toEqual(f.e.candidate)
              expect(saved.candidates.get('original')).toEqual(f.e.candidate)
              expect(saved.outcomes.get('selected')).toEqual(definitive)
              expect(saved.state.selected?.txid).toBe(selected.txid)
              expect(saved.state.unconfirmed[0]?.txid).toBe(cached.txid)
              expect(saved.state.unconfirmed[0]?.admission).toBe('pending')
              expect(
                opened.domain.ledger.read([address], f.clock, f.guard).records[0]?.value.txid
              ).toBe(f.e.candidate.txid)
            } finally {
              f.e.base.setPermitted(true)
              f.e.base.close(opened.domain)
            }
          }
        } finally {
          f.e.base.setPermitted(true)
          f.e.base.dispose()
        }
      }
    )
  )
}, 180000)
