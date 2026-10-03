import { Beef, MerklePath } from '@bsv/sdk'
import {
  retainedBEEFConfiguration,
  retainTransactionBEEF,
  hydrateRetainedTransactionBEEF
} from '../RetainedTransactionBEEF.js'
import { retainedBeefFixture } from './RetainedTransactionBEEFFixture.js'
const budget = { maximumBytes: 4194304 }
it('keeps the original raw subject and all parent history, owning configuration and response arrays', () => {
  const f = retainedBeefFixture(),
    supplied = { ...budget },
    owned = retainedBEEFConfiguration(supplied)!
  supplied.maximumBytes = 1
  expect(owned).toEqual(budget)
  expect(Object.isFrozen(owned)).toBe(true)
  expect(retainedBEEFConfiguration(undefined)).toBeUndefined()
  const plain = Beef.fromBinary(f.bytes).toBinary(),
    saved = retainTransactionBEEF(plain, f.txid, owned),
    restored = hydrateRetainedTransactionBEEF(Uint8Array.from(saved), f.txid, f.raw, owned),
    beef = Beef.fromBinary(restored)
  expect(beef.atomicTxid).toBe(f.txid)
  expect(beef.findTxid(f.parent.id('hex'))?.tx?.toBinary()).toEqual(f.parent.toBinary())
  expect(beef.findTxid(f.txid)?.tx?.toBinary()).toEqual(f.child.toBinary())
  saved.fill(0)
  expect(Beef.fromBinary(restored).atomicTxid).toBe(f.txid)
})
it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4194305])(
  'refuses malformed byte budget %s',
  maximumBytes => {
    expect(() => retainedBEEFConfiguration({ maximumBytes })).toThrow('byte limit')
  }
)
it('refuses a wrong Atomic marker, absent raw subject, changed current raw and complete serialized size overflow', () => {
  const f = retainedBeefFixture(),
    subjectless = Beef.fromBinary(f.parent.toAtomicBEEF()).toBinary(),
    plain = Beef.fromBinary(f.bytes).toBinary()
  expect(() => retainTransactionBEEF(f.bytes, f.parent.id('hex'), budget)).toThrow(
    'subject differs'
  )
  expect(() => retainTransactionBEEF(subjectless, f.txid, budget)).toThrow('subject differs')
  expect(() => hydrateRetainedTransactionBEEF(f.bytes, f.txid, f.parent, budget)).toThrow(
    'subject differs'
  )
  expect(() =>
    retainTransactionBEEF(f.bytes, f.txid, { maximumBytes: f.bytes.length - 1 })
  ).toThrow('byte limit')
  expect(() => retainTransactionBEEF(plain, f.txid, { maximumBytes: plain.length })).toThrow(
    'output byte limit'
  )
  f.raw.merklePath = new MerklePath(102, [[{ offset: 0, hash: f.txid, txid: true }]])
  const richer = hydrateRetainedTransactionBEEF(f.bytes, f.txid, f.raw, budget)
  expect(Beef.fromBinary(richer).findAtomicTransaction(f.txid)?.merklePath?.blockHeight).toBe(102)
  expect(Beef.fromBinary(richer).findTxid(f.parent.id('hex'))?.tx?.toBinary()).toEqual(
    f.parent.toBinary()
  )
  expect(() =>
    hydrateRetainedTransactionBEEF(f.bytes, f.txid, f.raw, { maximumBytes: f.bytes.length })
  ).toThrow('output byte limit')
})
it('excludes unrelated plain-BEEF transactions while retaining raw parents below a proven subject', () => {
  const f = retainedBeefFixture(),
    unrelated = retainedBeefFixture(5),
    aggregate = Beef.fromBinary(f.bytes)
  aggregate.mergeBeef(unrelated.bytes)
  const saved = Beef.fromBinary(retainTransactionBEEF(aggregate.toBinary(), f.txid, budget))
  expect(saved.txs.map(tx => tx.txid).sort()).toEqual([f.txid, f.parent.id('hex')].sort())
  expect(saved.findTxid(unrelated.txid)).toBeUndefined()
})
it('retains unresolved parent references without inventing raw history and visits shared references once', () => {
  const f = retainedBeefFixture(),
    aggregate = new Beef()
  // Deliberately duplicate input references exercise serialization traversal,
  // not transaction validity; an independent Script/chain verifier must refuse
  // invalid financial evidence. This helper never confers that authority.
  f.raw.inputs.push({ ...f.raw.inputs[0] })
  const txid = f.raw.id('hex')
  aggregate.mergeRawTx(f.raw.toBinary())
  const absent = Beef.fromBinary(retainTransactionBEEF(aggregate.toBinary(), txid, budget))
  expect(absent.findTxid(f.parent.id('hex'))).toBeUndefined()
  aggregate.mergeTxidOnly(f.parent.id('hex'))
  const unresolved = Beef.fromBinary(retainTransactionBEEF(aggregate.toBinary(), txid, budget))
  expect(unresolved.findTxid(f.parent.id('hex'))?.isTxidOnly).toBe(true)
  expect(unresolved.findTxid(txid)?.tx?.toBinary()).toEqual(f.raw.toBinary())
})
