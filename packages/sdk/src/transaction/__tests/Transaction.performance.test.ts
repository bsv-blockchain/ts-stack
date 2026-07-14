import { Beef } from '../Beef'
import BeefTx from '../BeefTx'
import MerklePath from '../MerklePath'
import Transaction from '../Transaction'
import Script from '../../script/Script'
import UnlockingScript from '../../script/UnlockingScript'

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
