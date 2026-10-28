import fc from 'fast-check'
import { Beef, MerklePath } from '@bsv/sdk'
import {
  retainTransactionBEEF,
  hydrateRetainedTransactionBEEF
} from '../RetainedTransactionBEEF.js'
import { retainedBeefFixture } from './RetainedTransactionBEEFFixture.js'
const MIN_PROPERTY_RUNS = 300,
  requested = Number(process.env.FAST_CHECK_NUM_RUNS),
  seed = Number(process.env.FAST_CHECK_SEED)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requested)
    ? Math.max(MIN_PROPERTY_RUNS, requested)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})
it('preserves every selected raw subject and parent under 300 plain/Atomic/current-leaf serialization and byte-budget histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.nat(2147483647),
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 0, max: 3 }),
      async (lockTime, plain, leaf, cut) => {
        const f = retainedBeefFixture(lockTime),
          input = plain ? Beef.fromBinary(f.bytes).toBinary() : f.bytes,
          config = { maximumBytes: cut === 1 ? input.length - 1 : 4194304 }
        let subject = f.txid
        if (cut === 2) subject = plain ? 'aa'.repeat(32) : f.parent.id('hex')
        if (cut === 1 || cut === 2)
          expect(() => retainTransactionBEEF(input, subject, config)).toThrow()
        else {
          const saved = retainTransactionBEEF(input, subject, config)
          if (cut === 3)
            expect(() => hydrateRetainedTransactionBEEF(saved, subject, f.parent, config)).toThrow(
              'subject differs'
            )
          else assertRestored(f, saved, leaf, config)
        }
      }
    )
  )
}, 150000)
function assertRestored(
  f: ReturnType<typeof retainedBeefFixture>,
  saved: number[],
  leaf: boolean,
  config: { maximumBytes: number }
) {
  if (leaf) f.raw.merklePath = new MerklePath(102, [[{ offset: 0, hash: f.txid, txid: true }]])
  const restored = Beef.fromBinary(hydrateRetainedTransactionBEEF(saved, f.txid, f.raw, config))
  expect(restored.atomicTxid).toBe(f.txid)
  expect(restored.findTxid(f.txid)?.tx?.toBinary()).toEqual(f.child.toBinary())
  expect(restored.findTxid(f.parent.id('hex'))?.tx?.toBinary()).toEqual(f.parent.toBinary())
  expect(restored.findAtomicTransaction(f.txid)?.merklePath?.blockHeight).toBe(
    leaf ? 102 : undefined
  )
}
