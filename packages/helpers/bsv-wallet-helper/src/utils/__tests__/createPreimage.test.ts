import { Script, Transaction, TransactionSignature } from '@bsv/sdk'
import { calculatePreimage } from '../createPreimage'

function sourceTransaction(satoshis = 0, lockingScript = Script.fromASM('OP_TRUE')): Transaction {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis, lockingScript })
  return source
}

function spendingTransaction(source: Transaction, sequence?: number): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    sequence,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  tx.addOutput({ satoshis: 0, lockingScript: Script.fromASM('OP_TRUE') })
  return tx
}

describe('calculatePreimage validation', () => {
  test('rejects missing transactions, inputs, invalid indices, and invalid signature scopes', () => {
    expect(() => calculatePreimage(null as any, 0, 'all', false)).toThrow('Transaction is required')
    expect(() => calculatePreimage({ inputs: [], outputs: [] } as any, 0, 'all', false)).toThrow(
      'Transaction must have at least one input'
    )
    expect(() => calculatePreimage({ inputs: [{}], outputs: [] } as any, 1, 'all', false)).toThrow(
      'Invalid inputIndex 1'
    )
    expect(() =>
      calculatePreimage({ inputs: [{}], outputs: [] } as any, 0, 'invalid' as any, false)
    ).toThrow('Invalid signOutputs "invalid"')
    expect(() =>
      calculatePreimage({ inputs: [{}], outputs: [] } as any, Number.NaN, 'all', false)
    ).toThrow('Invalid inputIndex NaN')
    expect(() =>
      calculatePreimage({ inputs: [{}], outputs: [] } as any, 0, 'all', 1 as any)
    ).toThrow('anyoneCanPay must be a boolean')
  })

  test('requires a matching output for SIGHASH_SINGLE', () => {
    expect(() =>
      calculatePreimage(
        {
          inputs: [{ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0 }],
          outputs: []
        } as any,
        0,
        'single',
        false,
        1,
        Script.fromASM('OP_TRUE')
      )
    ).toThrow('SIGHASH_SINGLE requires output at index 0')
  })

  test('requires a source transaction id, satoshi value, and locking script', () => {
    expect(() =>
      calculatePreimage({ inputs: [{ sourceOutputIndex: 0 }], outputs: [] } as any, 0, 'all', false)
    ).toThrow('sourceTXID or sourceTransaction is required')

    const input = { sourceTXID: '00'.repeat(32), sourceOutputIndex: 0 }
    expect(() =>
      calculatePreimage({ inputs: [input], outputs: [] } as any, 0, 'all', false)
    ).toThrow('sourceSatoshis or input sourceTransaction is required')
    expect(() =>
      calculatePreimage({ inputs: [input], outputs: [] } as any, 0, 'all', false, 1)
    ).toThrow('lockingScript or input sourceTransaction is required')
  })

  test('preserves zero-valued prevouts and a zero input sequence', () => {
    const tx = spendingTransaction(sourceTransaction(), 0)
    const format = jest.spyOn(TransactionSignature, 'format')

    try {
      expect(() => calculatePreimage(tx, 0, 'all', false)).not.toThrow()
      expect(format).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSatoshis: 0, inputSequence: 0 })
      )
    } finally {
      format.mockRestore()
    }
  })

  test('rejects conflicting source transaction IDs', () => {
    const tx = spendingTransaction(sourceTransaction(1))
    tx.inputs[0].sourceTXID = '11'.repeat(32)

    expect(() => calculatePreimage(tx, 0, 'all', false)).toThrow(
      'sourceTXID does not match sourceTransaction'
    )
  })

  test('rejects conflicting source amounts and locking scripts', () => {
    const sourceScript = Script.fromASM('OP_TRUE')
    const tx = spendingTransaction(sourceTransaction(7, sourceScript))

    expect(() => calculatePreimage(tx, 0, 'all', false, 8, sourceScript)).toThrow(
      'sourceSatoshis does not match sourceTransaction output'
    )
    expect(() => calculatePreimage(tx, 0, 'all', false, 7, Script.fromASM('OP_FALSE'))).toThrow(
      'lockingScript does not match sourceTransaction output'
    )
  })

  test('rejects malformed outpoints, amounts, scripts, and sequences', () => {
    const script = Script.fromASM('OP_TRUE')
    const baseInput = { sourceTXID: '00'.repeat(32), sourceOutputIndex: 0 }

    expect(() =>
      calculatePreimage(
        { inputs: [{ ...baseInput, sourceTXID: '00' }], outputs: [] } as any,
        0,
        'all',
        false,
        1,
        script
      )
    ).toThrow('sourceTXID must be a 32-byte hexadecimal transaction ID')
    expect(() =>
      calculatePreimage(
        { inputs: [{ ...baseInput, sourceOutputIndex: 0.5 }], outputs: [] } as any,
        0,
        'all',
        false,
        1,
        script
      )
    ).toThrow('sourceOutputIndex must be an unsigned 32-bit integer')
    expect(() =>
      calculatePreimage(
        { inputs: [baseInput], outputs: [] } as any,
        0,
        'all',
        false,
        Number.POSITIVE_INFINITY,
        script
      )
    ).toThrow('sourceSatoshis must be a valid number of satoshis')
    expect(() =>
      calculatePreimage(
        { inputs: [{ ...baseInput, sequence: -1 }], outputs: [] } as any,
        0,
        'all',
        false,
        1,
        script
      )
    ).toThrow('sequence must be an unsigned 32-bit integer')
    expect(() =>
      calculatePreimage({ inputs: [baseInput], outputs: [] } as any, 0, 'all', false, 1, {} as any)
    ).toThrow('lockingScript must be a Script')
  })
})
