import { LockingScript, Script, Transaction } from '@bsv/sdk'
import { boundPreimage, resolveBoundSource, signatureScope } from '../signing-context.js'

function makeSource(satoshis = 0, lockingScript = LockingScript.fromASM('OP_TRUE')): Transaction {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis, lockingScript })
  return source
}

function makeSpend(source: Transaction, sequence = 0): Transaction {
  const transaction = new Transaction()
  transaction.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence })
  transaction.addOutput({ satoshis: 0, lockingScript: Script.fromASM('OP_TRUE') })
  return transaction
}

describe('shared signing context', () => {
  test('validates runtime signature-scope options', () => {
    expect(() => signatureScope('invalid' as any, false)).toThrow(
      'signOutputs must be "all", "none", or "single"'
    )
    expect(() => signatureScope('all', 1 as any)).toThrow('anyoneCanPay must be a boolean')
  })

  test('preserves zero amounts and sequences', () => {
    const transaction = makeSpend(makeSource())
    const source = resolveBoundSource(transaction, 0)

    expect(source.sourceSatoshis).toBe(0)
    expect(() => boundPreimage(transaction, 0, source, signatureScope('all', false))).not.toThrow()
  })

  test('rejects SIGHASH_SINGLE when the signing input has no matching output', () => {
    const transaction = makeSpend(makeSource(1))
    transaction.addInput({ sourceTransaction: makeSource(1), sourceOutputIndex: 0 })

    // The historical two-argument helper remains available to external users;
    // every built-in signer uses the transaction-bound overload.
    expect(() => signatureScope('single', false)).not.toThrow()
    expect(() => signatureScope(transaction, 1, 'single', false)).toThrow(
      'requires an output at the signing input index'
    )
  })

  test('rejects conflicting embedded and explicit prevout context', () => {
    const lockingScript = LockingScript.fromASM('OP_TRUE')
    const transaction = makeSpend(makeSource(7, lockingScript))

    transaction.inputs[0].sourceTXID = '11'.repeat(32)
    expect(() => resolveBoundSource(transaction, 0)).toThrow(
      'input.sourceTXID does not match input.sourceTransaction'
    )
    transaction.inputs[0].sourceTXID = transaction.inputs[0].sourceTransaction!.id('hex')
    expect(() => resolveBoundSource(transaction, 0, 8, lockingScript)).toThrow(
      'sourceSatoshis does not match input.sourceTransaction output'
    )
    expect(() => resolveBoundSource(transaction, 0, 7, LockingScript.fromASM('OP_FALSE'))).toThrow(
      'lockingScript does not match input.sourceTransaction output'
    )
  })

  test('rejects malformed input indexes and source fields', () => {
    const transaction = makeSpend(makeSource(1))
    expect(() => resolveBoundSource(transaction, Number.NaN)).toThrow(
      'Transaction input NaN does not exist'
    )
    transaction.inputs[0].sourceOutputIndex = 0.5
    expect(() => resolveBoundSource(transaction, 0)).toThrow(
      'input.sourceOutputIndex must be an unsigned 32-bit integer'
    )
  })
})
