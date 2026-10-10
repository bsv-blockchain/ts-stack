import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON, parseOutputPurchaseEnvelope } from '@bsv/sdk'
import { purchaseAliasDisclosureFixture } from './private-purchase-alias-disclosure.fixture.js'

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

it('generated report availability and selected-view changes preserve one historical delivery with fenced physical responses', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('current', 'changed', 'unavailable', 'reopen'), {
        minLength: 1,
        maxLength: 3
      }),
      async history => {
        const x = await purchaseAliasDisclosureFixture()
        try {
          const initial = x.native().prepare(x.id, x.caller).body
          const expected = canonicalOutputJSON(parseOutputPurchaseEnvelope(JSON.parse(initial)))
          for (const action of history) {
            x.f.setCurrent(true)
            x.f.setMined(action !== 'unavailable')
            if (action === 'reopen') await x.f.reopen()
            const response = await x.make().prepareAsync(x.id, x.caller)
            const envelope = parseOutputPurchaseEnvelope(JSON.parse(response.body))
            const { currentAlias: alias, ...historical } = envelope
            expect(canonicalOutputJSON(historical)).toBe(expected)
            expect(alias === undefined).toBe(action === 'unavailable')
            let sent = 0
            if (action === 'changed') {
              x.f.setCurrent(false)
              expect(() =>
                response.enqueue(() => {
                  sent++
                })
              ).toThrow()
            } else
              response.enqueue(() => {
                sent++
              })
            expect(sent).toBe(action === 'changed' ? 0 : 1)
            expect(x.f.base.counts.issue).toBe(1)
            expect(x.f.base.counts.potatoes).toBe(1)
            expect(x.f.load().progress.txid).toBe(x.paid.txid)
          }
        } finally {
          await x.f.dispose()
        }
      }
    )
  )
}, 180000)
