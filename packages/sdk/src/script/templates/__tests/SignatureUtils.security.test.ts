import Transaction from '../../../transaction/Transaction.js'
import Script from '../../Script.js'
import {
  computeSignatureScope,
  formatPreimage,
  resolveSourceDetails
} from '../SignatureUtils.js'
import P2PKH from '../P2PKH.js'

function sourceTransaction (satoshis = 0, lockingScript = Script.fromASM('OP_TRUE')): Transaction {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis, lockingScript })
  return source
}

function spendingTransaction (source: Transaction, sequence = 0): Transaction {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    sequence,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  transaction.addOutput({ satoshis: 0, lockingScript: Script.fromASM('OP_TRUE') })
  return transaction
}

describe('signature source-context security', () => {
  test('rejects malformed P2PKH hash bytes', () => {
    const p2pkh = new P2PKH()
    for (const byte of [-1, 0.5, 256, Number.NaN]) {
      const hash = Array.from({ length: 20 }, () => 0)
      hash[19] = byte
      expect(() => p2pkh.lock(hash)).toThrow('P2PKH hash must be a dense byte array')
    }
    const sparse = Array.from({ length: 20 }) as number[]
    expect(() => p2pkh.lock(sparse)).toThrow('P2PKH hash must be a dense byte array')
  })

  test('rejects invalid runtime signature-scope values', () => {
    expect(() => computeSignatureScope('invalid' as any, false)).toThrow(
      'signOutputs must be "all", "none", or "single"'
    )
    expect(() => computeSignatureScope('all', 1 as any)).toThrow(
      'anyoneCanPay must be a boolean'
    )
  })

  test('preserves zero-valued source outputs and input sequences', () => {
    const transaction = spendingTransaction(sourceTransaction())
    const resolved = resolveSourceDetails(transaction, 0)

    expect(resolved.sourceSatoshis).toBe(0)
    expect(() => formatPreimage({
      tx: transaction,
      inputIndex: 0,
      signatureScope: computeSignatureScope('all', false),
      sourceTXID: resolved.sourceTXID,
      sourceSatoshis: resolved.sourceSatoshis,
      lockingScript: resolved.lockingScript,
      allInputs: resolved.allInputs,
      inputSequence: 0
    })).not.toThrow()
  })

  test('binds explicit transaction IDs, amounts, and scripts to the embedded prevout', () => {
    const script = Script.fromASM('OP_TRUE')
    const transaction = spendingTransaction(sourceTransaction(7, script))

    transaction.inputs[0].sourceTXID = '11'.repeat(32)
    expect(() => resolveSourceDetails(transaction, 0)).toThrow(
      'sourceTXID does not match the input sourceTransaction'
    )
    transaction.inputs[0].sourceTXID = transaction.inputs[0].sourceTransaction!.id('hex')

    expect(() => resolveSourceDetails(transaction, 0, 8, script)).toThrow(
      'sourceSatoshis does not match the input sourceTransaction output'
    )
    expect(() => resolveSourceDetails(transaction, 0, 7, Script.fromASM('OP_FALSE'))).toThrow(
      'lockingScript does not match the input sourceTransaction output'
    )
  })

  test('rejects malformed input indexes and source fields', () => {
    const transaction = spendingTransaction(sourceTransaction(1))

    expect(() => resolveSourceDetails(transaction, Number.NaN)).toThrow(
      'inputIndex NaN is outside the transaction input range'
    )
    transaction.inputs[0].sourceOutputIndex = 1
    expect(() => resolveSourceDetails(transaction, 0)).toThrow(
      'sourceTransaction has no output at index 1'
    )
    transaction.inputs[0].sourceOutputIndex = 0.5
    expect(() => resolveSourceDetails(transaction, 0)).toThrow(
      'input.sourceOutputIndex must be an unsigned 32-bit integer'
    )
  })
})
