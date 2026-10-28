import fc from 'fast-check'
import { createHash } from 'node:crypto'
import {
  makeFamily,
  corpus,
  previous,
  accepted,
  action,
  transaction
} from './RevenueListing.fixture.js'
import { RevenueListingSpend, revenueListingPurchaseCommitment } from '../RevenueListingSpend.js'
import TransactionSignature from '../../../primitives/TransactionSignature.js'
import { toHex, Writer } from '../../../primitives/utils.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('purchase unlocking ABI binds generated headers and change to every independently serialized prevout', () => {
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
      fc.integer({ min: 1, max: 2 }),
      (amount, version) => {
        const tx = transaction(trace.txid)
        trace.sources.forEach((source, index) => {
          tx.inputs[index].sourceTransaction = transaction(source.txid)
        })
        tx.outputs[2].satoshis = amount
        tx.version = version
        const completed = spend.prepare(tx).complete([{ recipients: [] }])
        const chunks = completed.inputs[0].unlockingScript!.chunks
        const input = tx.inputs[0],
          output = input.sourceTransaction!.outputs[input.sourceOutputIndex]
        const expected = TransactionSignature.format({
          sourceTXID: input.sourceTXID!,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: output.satoshis!,
          transactionVersion: version,
          otherInputs: tx.inputs.slice(1),
          outputs: tx.outputs,
          inputIndex: 0,
          subscript: output.lockingScript,
          inputSequence: input.sequence!,
          lockTime: 0,
          scope: 65
        })
        expect(chunks[0].data).toEqual(expected)
        const commitment = createHash('sha256')
          .update(createHash('sha256').update(Uint8Array.from(expected)).digest())
          .digest('hex')
        expect(revenueListingPurchaseCommitment(tx)).toBe(commitment)
        const prevouts = new Writer()
        for (const source of trace.sources)
          prevouts
            .write(Array.from(Buffer.from(source.txid, 'hex')).reverse())
            .writeUInt32LE(source.index)
        expect(chunks[1].data).toEqual(prevouts.toArray())
        expect(toHex(chunks[3].data!)).toBe(
          spend.plan().outputs[spend.plan().receiptIndex].lockingScript
        )
        expect(chunks).toHaveLength(14)
        expect(completed.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
          spend.estimateUnlockingLength(0)
        )
      }
    )
  )
}, 120000)
