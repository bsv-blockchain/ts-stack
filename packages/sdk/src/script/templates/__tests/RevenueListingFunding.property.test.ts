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
import LockingScript from '../../LockingScript.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('funding rejects generated changes to required output amounts and scripts before authority requests', () => {
  const family = makeFamily(),
    trace = accepted[0]
  const spend = new RevenueListingSpend(
    family,
    corpus.descriptor,
    previous(trace),
    action(trace, family)
  )
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10000 }), fc.boolean(), (delta, script) => {
      const tx = transaction(trace.txid)
      trace.sources.forEach((source, index) => {
        tx.inputs[index].sourceTransaction = transaction(source.txid)
      })
      if (script) tx.outputs[0].lockingScript = new LockingScript().writeNumber(delta)
      else tx.outputs[0].satoshis! += delta
      expect(() => spend.prepare(tx)).toThrow('Required listing output changed')
    })
  )
}, 120000)
