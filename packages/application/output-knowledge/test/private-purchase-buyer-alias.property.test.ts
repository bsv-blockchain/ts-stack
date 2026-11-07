import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseBuyerAliasFixture } from './private-purchase-buyer-alias.fixture.js'

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

it('generated fresh buyer report, missing view and native restart histories never replace historical rights or repeat payment', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('current', 'missing', 'unavailable', 'changed', 'reopen'), {
        minLength: 1,
        maxLength: 3
      }),
      async history => {
        const x = purchaseBuyerAliasFixture()
        try {
          let owner = await x.f.open(true)
          const historical = await owner.buyer.advance()
          await owner.buyer.validate()
          const expected = canonicalOutputJSON(historical)
          for (const action of history) {
            if (action === 'reopen') {
              await x.f.close(owner)
              owner = await x.f.open()
            }
            x.report(action !== 'missing')
            x.available(action !== 'unavailable')
            x.current(action !== 'changed')
            const before = await owner.state.read()
            if (action === 'changed')
              await expect(owner.buyer.currentAlias(x.make())).rejects.toThrow(
                'selected chain changed'
              )
            else
              expect((await owner.buyer.currentAlias(x.make())) !== undefined).toBe(
                !['missing', 'unavailable'].includes(action)
              )
            expect(await owner.state.read()).toEqual(before)
            expect(canonicalOutputJSON(await owner.buyer.usableResult())).toBe(expected)
            expect(x.f.counts.finish).toBe(1)
            expect(x.f.server.counts.issue).toBe(1)
          }
        } finally {
          await x.f.dispose()
        }
      }
    )
  )
}, 180000)
