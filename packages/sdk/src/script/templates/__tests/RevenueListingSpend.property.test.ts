import fc from 'fast-check'
import {
  makeFamily,
  corpus,
  previous,
  accepted,
  action,
  transaction
} from './RevenueListing.fixture.js'
import { RevenueListingSpend } from '../RevenueListingSpend.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('funded purchase preimages commit every input and output while caller snapshots remain owned', () => {
  const family = makeFamily(),
    trace = accepted[0]
  const spend = new RevenueListingSpend(
    family,
    corpus.descriptor,
    previous(trace),
    action(trace, family)
  )
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 98000 }),
      fc.integer({ min: 0, max: 1 }),
      (change, version) => {
        const tx = transaction(trace.txid)
        trace.sources.forEach((item, index) => {
          tx.inputs[index].sourceTransaction = transaction(item.txid)
        })
        tx.version = version + 1
        tx.outputs[2].satoshis = change
        const prepared = spend.prepare(tx)
        expect(prepared.signingRequests()).toEqual([])
        const completed = prepared.complete([{ recipients: [] }])
        expect(completed.outputs[2].satoshis).toBe(change)
        expect(completed.version).toBe(version + 1)
        expect(completed.inputs[0].unlockingScript!.chunks).toHaveLength(14)
        expect(() => prepared.assertFinalLayout(completed)).not.toThrow()
        tx.outputs[2].satoshis = change + 1
        expect(prepared.complete([{ recipients: [] }]).toHex()).toBe(completed.toHex())
        completed.outputs[2].satoshis = change + 1
        expect(() => prepared.assertFinalLayout(completed)).toThrow()
      }
    )
  )
}, 120000)
