import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseAliasCoordinatorFixture } from './private-purchase-alias-coordinator.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(seed) ? seed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

it('generated native coordinator restart and alias histories preserve one issuance and byte-exact historical recovery', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('reopen', 'recover', 'alias', 'retry'), {
        minLength: 1,
        maxLength: 5
      }),
      async history => {
        const f = purchaseAliasCoordinatorFixture()
        try {
          await f.prepare()
          const original = f.f.f.variant(50)
          await f.submit(original)
          const first = f.load(),
            expected = structuredClone(first.progress)
          let initial: unknown
          f.installation.store.disclose(first, f.f.base.buyer, f.f.f.clock, f.f.f.guard, value => {
            initial = value
          })
          const initialBytes = canonicalOutputJSON(initial)
          let variant = 51
          for (const action of history) {
            if (action === 'reopen') await f.reopen()
            else if (action === 'alias') {
              f.setMined(true)
              await f.submit(f.f.f.variant(variant++))
            } else if (action === 'retry') await f.submit(original)
            else await f.recover()
            const saved = f.load()
            expect(saved.progress).toEqual(expected)
            expect(saved.aliases.state.original?.txid).toBe(original.txid)
            expect(f.base.counts.issue).toBe(1)
            expect(f.base.counts.potatoes).toBe(1)
            let replay: unknown
            f.installation.store.disclose(
              saved,
              f.f.base.buyer,
              f.f.f.clock,
              f.f.f.guard,
              value => {
                replay = value
              }
            )
            expect(canonicalOutputJSON(replay)).toBe(initialBytes)
          }
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)
