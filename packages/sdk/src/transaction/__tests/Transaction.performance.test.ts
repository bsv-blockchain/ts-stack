import { ATOMIC_BEEF, Beef } from '../Beef'
import BeefTx from '../BeefTx'
import MerklePath from '../MerklePath'
import Transaction from '../Transaction'
import Script from '../../script/Script'
import UnlockingScript from '../../script/UnlockingScript'
import { toArray, WriterUint8Array } from '../../primitives/utils'

function makeDeepChain (depth: number): Transaction {
  let tx = new Transaction()
  const lockingScript = Script.fromHex('51')
  tx.addOutput({ lockingScript, satoshis: depth + 1 })
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(1, [[
    { offset: 0, hash: txid, txid: true },
    { offset: 1, hash: 'ab'.repeat(32) }
  ]])
  for (let i = 0; i < depth; i++) {
    const next = new Transaction()
    next.addInput({
      sourceTransaction: tx,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    next.addOutput({ lockingScript, satoshis: depth - i })
    tx = next
  }
  return tx
}

function makeChild (source: Transaction, satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: source.id('hex'),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff
  })
  tx.addOutput({ lockingScript: Script.fromHex('51'), satoshis })
  return tx
}

function makeProvenTransaction (satoshis: number, sibling: string, blockHeight: number = 1): Transaction {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: Script.fromHex('51'), satoshis })
  tx.merklePath = new MerklePath(blockHeight, [[
    { offset: 0, hash: tx.id('hex'), txid: true },
    { offset: 1, hash: sibling }
  ]])
  return tx
}

function makeMultiInputChild (sources: Transaction[], satoshis: number): Transaction {
  const tx = new Transaction()
  for (const source of sources) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromHex('')
    })
  }
  tx.addOutput({ lockingScript: Script.fromHex('51'), satoshis })
  return tx
}

function serializeWithoutSorting (beef: Beef): Uint8Array {
  const writer = new WriterUint8Array()
  beef.toWriter(writer)
  return writer.toUint8Array()
}

describe('transaction pipeline scalability', () => {
  it('serializes, links, and verifies a 3,000-deep source graph without recursion overflow', async () => {
    const tx = makeDeepChain(3000)
    const bytes = tx.toBEEFBytes()
    const beef = Beef.fromBinaryView(bytes)

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(beef.txs).toHaveLength(3001)
    expect(beef.txs.every(btx => btx._tx == null)).toBe(true)

    const linked = beef.findAtomicTransaction(tx.id('hex'))
    expect(linked).toBeDefined()
    if (linked == null) throw new Error('Expected linked transaction')
    expect(linked.inputs[0].sourceTransaction).toBeDefined()
    await expect(linked.verify('scripts only')).resolves.toBe(true)
  })

  it('keeps the deprecated runtime shape while providing a correct typed replacement', () => {
    const tx = makeDeepChain(2)
    const legacy = tx.toBEEFUint8Array()
    const bytes = tx.toBEEFBytes()

    expect(Array.isArray(legacy)).toBe(true)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(bytes)).toEqual(legacy)
  })

  it('retains raw transaction views and parses transaction objects lazily', () => {
    const bytes = makeDeepChain(10).toBEEFBytes()
    const beef = Beef.fromBinaryView(bytes)
    const newest = beef.txs.at(-1)
    if (newest == null) throw new Error('Expected newest transaction')
    const forwarded = beef.toUint8Array()

    expect(newest._tx).toBeUndefined()
    expect(newest.inputTxids).toHaveLength(1)
    expect(newest.tx).toBeDefined()
    expect(newest._tx).toBeDefined()
    expect(beef.txs.slice(0, -1).every(btx => btx._tx == null)).toBe(true)
    expect(beef.toUint8Array()).toBe(forwarded)
  })

  it('retains legacy serialization of mutations made after lazy parsing', () => {
    const beef = Beef.fromBinaryView(makeDeepChain(2).toBEEFBytes())
    const newest = beef.txs.at(-1)
    if (newest?.tx == null) throw new Error('Expected newest transaction')
    const oldTxid = newest.txid

    newest.tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex('51') })
    const reparsed = Beef.fromBinary(beef.toUint8Array())

    expect(newest.txid).not.toBe(oldTxid)
    expect(reparsed.txs.at(-1)?.tx?.outputs).toHaveLength(2)
  })

  it('links Atomic BEEF through an explicit zero-copy API', () => {
    const tx = makeDeepChain(25)
    const atomic = tx.toAtomicBEEFUint8Array()
    const linked = Transaction.fromAtomicBEEFView(atomic)

    expect(linked.id('hex')).toBe(tx.id('hex'))
    expect(linked.inputs[0].sourceTransaction).toBeDefined()
  })

  it('retains required ancestors when extracting Atomic BEEF from parsed out-of-order data', () => {
    const anchor = makeProvenTransaction(2, 'ab'.repeat(32))
    const child = makeChild(anchor, 1)
    const beef = new Beef()
    const anchorBeefTx = beef.mergeRawTx(anchor.toUint8Array())
    const childBeefTx = beef.mergeRawTx(child.toUint8Array())
    if (anchor.merklePath == null) throw new Error('Expected anchor proof')
    beef.mergeBump(anchor.merklePath)
    beef.txs = [childBeefTx, anchorBeefTx]

    const parsed = Beef.fromBinaryView(serializeWithoutSorting(beef))
    const atomic = Beef.fromBinary(parsed.toUint8ArrayAtomic(child.id('hex')))

    expect(atomic.txs.map(tx => tx.txid)).toEqual([anchor.id('hex'), child.id('hex')])
    expect(atomic.isValid()).toBe(true)
  })

  it('excludes unrelated transactions and remaps proofs during Atomic BEEF extraction', () => {
    const unrelated = makeProvenTransaction(10, 'cd'.repeat(32))
    const anchor = makeProvenTransaction(2, 'ab'.repeat(32))
    const child = makeChild(anchor, 1)
    const beef = new Beef()
    beef.mergeRawTx(unrelated.toUint8Array())
    if (unrelated.merklePath == null) throw new Error('Expected unrelated proof')
    beef.mergeBump(unrelated.merklePath)
    beef.mergeRawTx(anchor.toUint8Array())
    if (anchor.merklePath == null) throw new Error('Expected anchor proof')
    beef.mergeBump(anchor.merklePath)
    beef.mergeRawTx(child.toUint8Array())

    const atomic = Beef.fromBinary(beef.toUint8ArrayAtomic(child.id('hex')))

    expect(atomic.txs.map(tx => tx.txid)).toEqual([anchor.id('hex'), child.id('hex')])
    expect(atomic.bumps).toHaveLength(1)
    expect(atomic.txs[0].bumpIndex).toBe(0)
    expect(atomic.isValid()).toBe(true)
  })

  it('extracts a branching shared-ancestor closure once from shuffled BEEF', () => {
    const firstAnchor = makeProvenTransaction(8, 'ab'.repeat(32), 1)
    const secondAnchor = makeProvenTransaction(7, 'cd'.repeat(32), 2)
    const middle = makeMultiInputChild([firstAnchor, secondAnchor], 6)
    const subject = makeMultiInputChild([middle, firstAnchor], 5)
    const unrelated = makeProvenTransaction(4, 'ef'.repeat(32), 3)
    const beef = new Beef()
    const transactions = [subject, unrelated, middle, secondAnchor, firstAnchor]
    beef.txs = transactions.map(tx => BeefTx.fromRawTx(tx.toUint8Array()))
    for (const anchor of [unrelated, secondAnchor, firstAnchor]) {
      if (anchor.merklePath == null) throw new Error('Expected proof')
      beef.bumps.push(anchor.merklePath)
    }
    beef.txs[1].bumpIndex = 0
    beef.txs[3].bumpIndex = 1
    beef.txs[4].bumpIndex = 2

    const parsed = Beef.fromBinaryView(serializeWithoutSorting(beef))
    const atomic = Beef.fromBinaryView(parsed.toUint8ArrayAtomic(subject.id('hex')))
    const expected = [firstAnchor, secondAnchor, middle, subject].map(tx => tx.id('hex'))

    expect(new Set(atomic.txs.map(tx => tx.txid))).toEqual(new Set(expected))
    expect(atomic.txs).toHaveLength(expected.length)
    expect(atomic.bumps).toHaveLength(2)
    expect(atomic.isAtomic()).toBe(true)
    expect(atomic.isValid()).toBe(true)
  })

  it('rejects incoming Atomic BEEF containing unrelated transactions', () => {
    const unrelated = makeProvenTransaction(10, 'cd'.repeat(32))
    const anchor = makeProvenTransaction(2, 'ab'.repeat(32))
    const child = makeChild(anchor, 1)
    const beef = new Beef()
    for (const tx of [unrelated, anchor, child]) beef.mergeRawTx(tx.toUint8Array())
    if (unrelated.merklePath == null || anchor.merklePath == null) throw new Error('Expected proofs')
    beef.mergeBump(unrelated.merklePath)
    beef.mergeBump(anchor.merklePath)
    beef.sortTxs()

    const writer = new WriterUint8Array()
    writer.writeUInt32LE(ATOMIC_BEEF)
    writer.writeReverse(toArray(child.id('hex'), 'hex'))
    beef.toWriter(writer)

    const bytes = writer.toUint8Array()
    expect(Beef.fromBinary(bytes).isValid()).toBe(false)
    expect(() => Transaction.fromAtomicBEEF(bytes)).toThrow('unrelated transaction data')
    expect(() => Transaction.fromAtomicBEEFView(bytes)).toThrow('unrelated transaction data')
  })

  it.each([
    ['parsed', (): Beef => Beef.fromBinaryView(makeDeepChain(1).toBEEFBytes())],
    ['constructed', (): Beef => {
      const beef = new Beef()
      beef.mergeTransaction(makeDeepChain(1))
      return beef
    }]
  ])('synchronizes nested transaction mutation before answering validity for %s BEEF', (_kind, makeBeef) => {
    const beef = makeBeef()
    expect(beef.isValid()).toBe(true)
    const proven = beef.txs.find(tx => tx.hasProof)?.tx
    if (proven == null) throw new Error('Expected proven transaction')

    proven.addOutput({ lockingScript: Script.fromHex('51'), satoshis: 0 })
    const validBeforeSerialization = beef.isValid()

    expect(validBeforeSerialization).toBe(false)
    beef.toUint8Array()
    expect(beef.isValid()).toBe(validBeforeSerialization)
  })

  it('invalidates transaction and nested BEEF caches after direct public-field mutation', () => {
    const proven = makeProvenTransaction(3, 'ab'.repeat(32))
    const beef = new Beef()
    beef.mergeTransaction(proven)

    const initialBytes = proven.toUint8Array()
    const initialHex = proven.toHex()
    const initialTxid = proven.id('hex')
    expect(beef.isValid()).toBe(true)

    // These fields are intentionally public API. Cache correctness cannot rely
    // exclusively on callers using addOutput()/fee()/sign().
    proven.version++
    proven.lockTime++
    proven.outputs[0].satoshis = 4
    proven.outputs[0].lockingScript = Script.fromHex('5151')

    expect(proven.toUint8Array()).not.toEqual(initialBytes)
    expect(proven.toHex()).not.toBe(initialHex)
    expect(proven.id('hex')).not.toBe(initialTxid)
    expect(beef.isValid()).toBe(false)
    beef.toUint8Array()
    expect(beef.isValid()).toBe(false)
  })

  it('does not expose the mutable transaction hash cache', () => {
    const tx = makeDeepChain(0)
    const expected = tx.id('hex')
    const hash = tx.hash() as number[]
    hash.fill(0)
    expect(tx.id('hex')).toBe(expected)
  })

  it('invalidates BEEF serialization and proof lookup after nested BUMP mutation', () => {
    const proven = makeProvenTransaction(1, 'ab'.repeat(32))
    const beef = new Beef()
    beef.mergeTransaction(proven)
    const txid = proven.id('hex')
    const initialBytes = beef.toUint8Array()

    expect(beef.findBump(txid)).toBeDefined()
    beef.bumps[0].path[0][0].hash = 'cd'.repeat(32)

    expect(beef.findBump(txid)).toBeUndefined()
    expect(beef.toUint8Array()).not.toEqual(initialBytes)
    expect(beef.isValid()).toBe(false)
  })

  it('rejects duplicate transaction IDs and invalid bump indexes without throwing', () => {
    const proven = makeProvenTransaction(1, 'ab'.repeat(32))
    if (proven.merklePath == null) throw new Error('Expected proof')

    const duplicate = new Beef()
    duplicate.bumps = [proven.merklePath]
    duplicate.txs = [
      BeefTx.fromRawTx(proven.toUint8Array(), 0),
      BeefTx.fromRawTx(proven.toUint8Array(), 0)
    ]
    expect(Beef.fromBinary(serializeWithoutSorting(duplicate)).isValid()).toBe(false)

    const invalidBump = new Beef()
    invalidBump.txs = [BeefTx.fromRawTx(proven.toUint8Array(), 99)]
    const parsed = Beef.fromBinary(serializeWithoutSorting(invalidBump))
    expect(() => parsed.isValid()).not.toThrow()
    expect(parsed.isValid()).toBe(false)
  })

  it('keeps copy-safe parsing separate from explicit zero-copy parsing', () => {
    const original = makeDeepChain(3).toBEEFBytes()
    const copied = Beef.fromBinary(original)
    const viewed = Beef.fromBinaryView(original)
    const copiedFirst = copied.toUint8Array()[0]

    original[0] ^= 0xff
    expect(copied.toUint8Array()[0]).toBe(copiedFirst)
    expect(viewed.toUint8Array()[0]).toBe(original[0])
  })

  it('preserves legacy BEEF prefix parsing while the view API checks framing', () => {
    const beefBytes = makeDeepChain(1).toBEEFBytes()
    const beefWithTrailingData = new Uint8Array(beefBytes.length + 2)
    beefWithTrailingData.set(beefBytes)
    beefWithTrailingData.set([0xaa, 0xbb], beefBytes.length)
    expect(Beef.fromBinary(beefWithTrailingData).toUint8Array()).toEqual(beefBytes)
    expect(() => Beef.fromBinaryView(beefWithTrailingData)).toThrow('trailing data')
  })

  it('computes canonical transaction IDs directly from lazy raw bytes', () => {
    const tx = makeDeepChain(1)
    expect(BeefTx.fromRawTx(tx.toUint8Array()).txid).toBe(tx.id('hex'))
  })

  it('invalidates serialized transaction bytes when an output is added', () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const before = tx.toHex()
    tx.addOutput({ satoshis: 2, lockingScript: Script.fromHex('51') })

    expect(tx.toHex()).not.toBe(before)
    expect(Transaction.fromHex(tx.toHex()).outputs).toHaveLength(2)
  })

  it('preserves legacy stable ordering while topologically sorting in linear time', () => {
    const anchor = makeDeepChain(0)
    const first = makeChild(anchor, 3)
    const independent = makeChild(anchor, 2)
    const dependent = makeChild(first, 1)
    const beef = new Beef()
    for (const tx of [first, dependent, independent, anchor]) beef.mergeRawTx(tx.toUint8Array())
    if (anchor.merklePath == null) throw new Error('Expected anchor proof')
    beef.mergeBump(anchor.merklePath)

    beef.sortTxs()

    expect(beef.txs.map(tx => tx.txid)).toEqual([
      anchor.id('hex'),
      first.id('hex'),
      dependent.id('hex'),
      independent.id('hex')
    ])
  })

  it('preserves the relative order of entries after explicit removal', () => {
    const anchor = makeDeepChain(0)
    const first = makeChild(anchor, 3)
    const middle = makeChild(anchor, 2)
    const last = makeChild(anchor, 1)
    const beef = new Beef()
    for (const tx of [first, middle, last]) beef.mergeRawTx(tx.toUint8Array())

    beef.removeExistingTxid(middle.id('hex'))

    expect(beef.txs.map(tx => tx.txid)).toEqual([first.id('hex'), last.id('hex')])
  })

  it('does not retain transaction bytes cached by a signing template before hydration', async () => {
    const source = makeDeepChain(0)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
      unlockingScriptTemplate: {
        sign: async transaction => {
          transaction.toHex()
          return UnlockingScript.fromHex('51')
        },
        estimateLength: async () => 1
      }
    })
    tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex('51') })

    await tx.sign()

    expect(Transaction.fromHex(tx.toHex()).inputs[0].unlockingScript?.toHex()).toBe('51')
  })
})
