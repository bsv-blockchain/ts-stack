import fc from 'fast-check'
import { LockingScript, Transaction } from '../../../mod.js'
import { inspectOutputPaidLookupFunding } from '../OutputPaidLookupFunding.js'
import { fundingFixture } from './OutputPaidLookupFunding.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('every output position is examined and duplicate or inexact payment outputs never become funding', async () => {
  const fixture = await fundingFixture()
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 0, max: 15 }),
      fc.constantFrom('valid', 'duplicate', 'inexact'),
      (amount, position, mode) => {
        const transaction = Transaction.fromHex(fixture.transaction.toHex())
        transaction.inputs[0].sourceTransaction = fixture.source
        transaction.outputs = Array.from({ length: 16 }, () => ({
          satoshis: 0,
          lockingScript: LockingScript.fromHex('51')
        }))
        transaction.outputs[position] = {
          satoshis: amount + (mode === 'inexact' ? 1 : 0),
          lockingScript: fixture.script
        }
        if (mode === 'duplicate')
          transaction.outputs[(position + 1) % 16] = {
            satoshis: amount + 1,
            lockingScript: fixture.script
          }
        const inspect = () =>
          inspectOutputPaidLookupFunding(
            fixture.payment(transaction),
            { ...fixture.challenge, satoshis: String(amount) },
            fixture.selected
          )
        if (mode === 'valid') {
          const result = inspect()
          expect(result.operation.funding.outputIndex).toBe(position)
          expect(result.operation.funding.txid).toBe(transaction.id('hex'))
          expect(result.operation.satoshis).toBe(String(amount))
        } else expect(inspect).toThrow(mode === 'duplicate' ? 'exactly one' : 'equal challenged')
      }
    )
  )
})
