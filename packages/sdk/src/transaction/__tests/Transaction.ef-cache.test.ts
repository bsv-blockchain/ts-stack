import { P2PKH, PrivateKey, Script, Transaction } from '../../../mod'

async function buildTransaction (): Promise<Transaction> {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_TRUE') })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('Transaction EF serialization cache', () => {
  it('memoizes typed EF bytes and retains number-array compatibility', async () => {
    const tx = await buildTransaction()
    const first = tx.toEFBinary()
    expect(tx.toEFBinary()).toBe(first)
    expect(tx.toEFUint8Array()).toBe(first)
    expect(tx.toEF()).toEqual(Array.from(first))
    const copy = first.slice()
    copy[0] ^= 0xff
    expect(tx.toEFBinary()[0]).not.toBe(copy[0])
  })

  it('invalidates when a referenced source output changes', async () => {
    const tx = await buildTransaction()
    const first = tx.toEFUint8Array()
    const source = tx.inputs[0].sourceTransaction
    if (source === undefined) throw new Error('missing fixture source')
    source.outputs[0].satoshis = 3
    const second = tx.toEFUint8Array()
    expect(second).not.toBe(first)
    expect(second).not.toEqual(first)
  })

  it('invalidates for source-script, input-script, and destination-output mutations', async () => {
    const tx = await buildTransaction()
    const source = tx.inputs[0].sourceTransaction
    if (source === undefined) throw new Error('missing fixture source')
    const first = tx.toEFUint8Array()
    source.outputs[0].lockingScript = Script.fromASM('OP_TRUE')
    const sourceChanged = tx.toEFUint8Array()
    expect(sourceChanged).not.toBe(first)
    expect(sourceChanged).not.toEqual(first)

    tx.inputs[0].unlockingScript = Script.fromASM('OP_1')
    const inputChanged = tx.toEFUint8Array()
    expect(inputChanged).not.toBe(sourceChanged)
    expect(inputChanged).not.toEqual(sourceChanged)

    tx.outputs[0].lockingScript = Script.fromASM('OP_FALSE')
    const outputChanged = tx.toEFUint8Array()
    expect(outputChanged).not.toBe(inputChanged)
    expect(outputChanged).not.toEqual(inputChanged)
  })

  it('invalidates for transaction header, sequence, and output amount mutations', async () => {
    const tx = await buildTransaction()
    let previous = tx.toEFBinary()

    const expectInvalidated = (mutate: () => void): void => {
      mutate()
      const next = tx.toEFBinary()
      expect(next).not.toBe(previous)
      expect(next).not.toEqual(previous)
      previous = next
    }

    expectInvalidated(() => { tx.version = 2 })
    expectInvalidated(() => { tx.lockTime = 1 })
    expectInvalidated(() => { tx.inputs[0].sequence = 0xfffffffe })
    expectInvalidated(() => { tx.outputs[0].satoshis = 0 })
  })
})
