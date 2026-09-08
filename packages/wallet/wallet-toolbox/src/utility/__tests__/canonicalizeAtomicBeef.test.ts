import { Beef, Script, Transaction } from '@bsv/sdk'
import { canonicalizeAtomicBeef } from '../canonicalizeAtomicBeef'

const subjectTxid = '11'.repeat(32)
const unrelatedTxid = '22'.repeat(32)
const dependencyTxid = '33'.repeat(32)

function legacyAtomicEnvelope(): {
  bytes: number[]
  dependencyTxid: string
  subjectTxid: string
  unrelatedTxid: string
} {
  const dependency = new Transaction()
  dependency.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_TRUE') })
  const subject = new Transaction()
  subject.addInput({
    sourceTransaction: dependency,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  subject.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  const unrelated = new Transaction()
  unrelated.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })

  const beef = new Beef()
  beef.mergeTransaction(dependency)
  beef.mergeTransaction(subject)
  beef.mergeTransaction(unrelated)

  const resolvedSubjectTxid = subject.id('hex')
  const atomicHeader = beef.toBinaryAtomic(resolvedSubjectTxid).slice(0, 36)
  return {
    bytes: [...atomicHeader, ...beef.toBinary()],
    dependencyTxid: dependency.id('hex'),
    subjectTxid: resolvedSubjectTxid,
    unrelatedTxid: unrelated.id('hex')
  }
}

describe('canonicalizeAtomicBeef', () => {
  test('prunes unrelated legacy BEEF branches around the declared atomic subject', () => {
    const fixture = legacyAtomicEnvelope()
    const legacy = Beef.fromBinary(fixture.bytes)
    expect(legacy.atomicTxid).toBe(fixture.subjectTxid)
    expect(legacy.isAtomic()).toBe(false)

    const canonical = canonicalizeAtomicBeef(fixture.bytes)

    expect(canonical.atomicTxid).toBe(fixture.subjectTxid)
    expect(canonical.isAtomic()).toBe(true)
    expect(canonical.findTxid(fixture.subjectTxid)).toBeDefined()
    expect(canonical.findTxid(fixture.dependencyTxid)).toBeDefined()
    expect(canonical.findTxid(fixture.unrelatedTxid)).toBeUndefined()
  })

  test('preserves malformed envelopes for the existing strict validation failure', () => {
    const unrelated = new Beef()
    unrelated.mergeTxidOnly(unrelatedTxid)
    const atomicHeader = unrelated.toBinaryAtomic(unrelatedTxid).slice(0, 4)
    const missingSubject = [...atomicHeader, ...Array.from({ length: 32 }, () => 0x11), ...unrelated.toBinary()]

    const canonical = canonicalizeAtomicBeef(missingSubject)

    expect(canonical.atomicTxid).toBe(subjectTxid)
    expect(canonical.findTxid(subjectTxid)).toBeUndefined()
    expect(canonical.isAtomic()).toBe(false)
  })

  test('does not hide a missing subject dependency from strict verification', () => {
    const subjectTransaction = new Transaction()
    subjectTransaction.addInput({
      sourceTXID: dependencyTxid,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    subjectTransaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    const resolvedSubjectTxid = subjectTransaction.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(subjectTransaction)
    beef.mergeTxidOnly(unrelatedTxid)
    const atomicHeader = beef.toBinaryAtomic(resolvedSubjectTxid).slice(0, 36)
    const legacy = [...atomicHeader, ...beef.toBinary()]

    const canonical = canonicalizeAtomicBeef(legacy)

    expect(canonical.findTxid(unrelatedTxid)).toBeUndefined()
    expect(canonical.findTxid(resolvedSubjectTxid)?.inputTxids).toEqual([dependencyTxid])
    expect(canonical.sortTxs().missingInputs).toContain(dependencyTxid)
  })
})
