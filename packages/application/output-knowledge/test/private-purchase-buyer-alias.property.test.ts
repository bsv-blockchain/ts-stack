import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseBuyerAliasFixture } from './private-purchase-buyer-alias.fixture.js'

const MIN_PROPERTY_RUNS = 300
const NATIVE_HISTORY_BATCH_SIZE = 50
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const numRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
const seed = Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026
fc.configureGlobal({
  seed,
  numRuns,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})
const history = fc.array(
  fc.constantFrom('current', 'missing', 'unavailable', 'changed', 'reopen'),
  {
    minLength: 1,
    maxLength: 3
  }
)

// Use fast-check's original generator index for each batch, keeping the seed, bias,
// shrink paths, and every native history independent of runner throughput.
function nativeHistoryBatches(total: number) {
  return Array.from({ length: Math.ceil(total / NATIVE_HISTORY_BATCH_SIZE) }, (_, index) => {
    const offset = index * NATIVE_HISTORY_BATCH_SIZE
    return { path: String(offset), numRuns: Math.min(NATIVE_HISTORY_BATCH_SIZE, total - offset) }
  })
}

it('preserves the original generated sequence and replay index across native history batches', () => {
  const total = MIN_PROPERTY_RUNS + 13
  const batches = nativeHistoryBatches(total)
  expect(batches.every(batch => batch.numRuns > 0 && batch.numRuns <= 50)).toBe(true)
  expect(batches.flatMap(batch => fc.sample(history, { seed, ...batch }))).toEqual(
    fc.sample(history, { seed, numRuns: total })
  )

  const result = fc.check(
    fc.property(history, () => false),
    {
      seed,
      path: batches[1].path,
      numRuns: 1,
      endOnFailure: true
    }
  )
  expect(result.counterexamplePath).toBe(batches[1].path)
})

const batches = replayPath ? [{ path: replayPath, numRuns }] : nativeHistoryBatches(numRuns)
it.each(batches)(
  'generated fresh buyer report, missing view and native restart histories never replace historical rights or repeat payment (path $path, $numRuns cases)',
  async batch => {
    await fc.assert(
      fc.asyncProperty(history, async actions => {
        const x = purchaseBuyerAliasFixture()
        try {
          let owner = await x.f.open(true)
          const historical = await owner.buyer.advance()
          await owner.buyer.validate()
          const expected = canonicalOutputJSON(historical)
          for (const action of actions) {
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
      }),
      batch
    )
  },
  180000
)
