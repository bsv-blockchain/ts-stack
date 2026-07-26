import { Script } from '@bsv/sdk'
import { calculatePreimage } from '../createPreimage'

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
})
