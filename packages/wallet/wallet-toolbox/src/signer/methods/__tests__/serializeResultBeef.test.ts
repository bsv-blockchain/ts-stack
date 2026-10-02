import { Beef, Script, Transaction } from '@bsv/sdk'
import { serializeResultBeef } from '../createAction'

function outputTransaction(): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
  return tx
}

describe('serializeResultBeef', () => {
  test('returns the untouched atomic BEEF when nothing is declared', () => {
    const subject = outputTransaction()
    const beef = new Beef()
    beef.mergeTransaction(subject)
    const txid = subject.id('hex')
    const untouched = beef.toBinaryAtomic(txid)

    expect(serializeResultBeef(beef, txid)).toEqual(untouched)
    expect(serializeResultBeef(beef, txid, [])).toEqual(untouched)
    expect(beef.findTxid(txid)?.isTxidOnly).toBe(false)
  })

  test('omits a declared ancestor and keeps the subject even when it is declared', () => {
    const ancestor = outputTransaction()
    const subject = new Transaction()
    subject.addInput({
      sourceTransaction: ancestor,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    subject.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const beef = new Beef()
    beef.mergeTransaction(ancestor)
    beef.mergeTransaction(subject)

    const subjectTxid = subject.id('hex')
    const ancestorTxid = ancestor.id('hex')
    const absent = 'ab'.repeat(32)
    const parsed = Beef.fromBinary(serializeResultBeef(beef, subjectTxid, [subjectTxid, absent, ancestorTxid]))

    expect(parsed.findTxid(subjectTxid)?.isTxidOnly).toBe(false)
    expect(parsed.findTxid(ancestorTxid)?.isTxidOnly).toBe(true)
    expect(parsed.findTxid(absent)).toBeUndefined()
    expect(beef.findTxid(ancestorTxid)?.isTxidOnly).toBe(false)
  })
})
