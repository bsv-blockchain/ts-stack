import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { Beef, canonicalOutputJSON, decodeOutputBytes } from '@bsv/sdk'
import { SQLitePrivatePurchaseEvidence } from '../src/private/SQLitePrivatePurchaseEvidence.js'
import { purchaseEvidenceFixture } from './private-purchase-evidence.fixture.js'

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
it('retains the original transaction across 300 generated native proof recovery and merge histories', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  let richer = false
  f.owner.reserve(f.original, clock, guard)
  f.owner.propose(f.original, f.candidate, clock, guard).retain(clock, guard)
  try {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('old', 'rich', 'read', 'refuse', 'mutate', 'historical'), {
          minLength: 1,
          maxLength: 6
        }),
        history => {
          const opened = f.base.open(),
            owner = new SQLitePrivatePurchaseEvidence(opened.domain, f.base.f.f.contracts, f.limits)
          try {
            for (const step of history) {
              if (step === 'refuse') {
                f.base.setPermitted(false)
                expect(() => owner.read(f.original, clock, guard)).toThrow('authority changed')
                f.base.setPermitted(true)
              } else if (step === 'old' || step === 'rich') {
                owner
                  .propose(f.original, step === 'old' ? f.candidate : f.alternate, clock, guard)
                  .retain(clock, guard)
                richer ||= step === 'rich'
              } else if (step === 'mutate') {
                const before = owner.read(f.original, clock, guard).candidate!
                const exact = canonicalOutputJSON(before)
                before.beef = 'AA=='
                expect(canonicalOutputJSON(owner.read(f.original, clock, guard).candidate)).toBe(
                  exact
                )
              } else if (step === 'historical') {
                f.base.setNow('100000')
              }
              const retained = owner.read(f.original, clock, guard).candidate!,
                beef = Beef.fromBinaryStrict(decodeOutputBytes(retained.beef, 8192))
              expect(retained.acquisitionId).toBe(f.candidate.acquisitionId)
              expect(retained.txid).toBe(f.candidate.txid)
              expect(beef.findTxid(retained.txid)!.tx!.toHex()).toBe(f.target.toHex())
              expect(beef.bumps[0].computeRoot()).toBe(f.path.computeRoot())
              expect(beef.txs).toHaveLength(richer ? 3 : 2)
            }
          } finally {
            f.base.setPermitted(true)
            f.base.close(opened.domain)
          }
        }
      )
    )
  } finally {
    f.base.dispose()
  }
}, 180000)
