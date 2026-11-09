import {
  transactionInputSize,
  transactionOutputSize,
  transactionSize,
  varUintSize
} from '../transactionSize'
import * as sdk from '../../../mod'
import Transaction from '../Transaction'
import LockingScript from '../../script/LockingScript'
import UnlockingScript from '../../script/UnlockingScript'
import SatoshisPerKilobyte from '../fee-models/SatoshisPerKilobyte'

const TXID = '00'.repeat(32)

function builtTransaction(inputs: number[], outputs: number[]): Transaction {
  return new Transaction(
    1,
    inputs.map(length => ({
      sourceTXID: TXID,
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromBinary(Array.from({ length }, () => 0x51)),
      sequence: 0xffffffff
    })),
    outputs.map(length => ({
      satoshis: 1,
      lockingScript: LockingScript.fromBinary(Array.from({ length }, () => 0x51))
    })),
    0
  )
}

describe('transactionSize', () => {
  it('is exported from the package root', () => {
    expect(sdk.transactionSize).toBe(transactionSize)
    expect(sdk.transactionInputSize).toBe(transactionInputSize)
    expect(sdk.transactionOutputSize).toBe(transactionOutputSize)
    expect(sdk.varUintSize).toBe(varUintSize)
  })

  it('sizes a one-input, two-output P2PKH transaction at 226 bytes', () => {
    expect(transactionSize([107], [25, 25])).toBe(226)
    expect(transactionInputSize(107)).toBe(148)
    expect(transactionOutputSize(25)).toBe(34)
  })

  it('sizes an empty transaction at 10 bytes', () => {
    expect(transactionSize([], [])).toBe(10)
  })

  it.each([
    { inputs: [107], outputs: [25] },
    { inputs: [0, 72, 252], outputs: [0, 25] },
    { inputs: [253, 254], outputs: [65535] },
    { inputs: [65536], outputs: [1] },
    { inputs: [], outputs: Array.from({ length: 253 }, () => 25) }
  ])(
    'matches the serialized length of a built transaction ($inputs / $outputs.length outputs)',
    ({ inputs, outputs }) => {
      expect(transactionSize(inputs, outputs)).toBe(
        builtTransaction(inputs, outputs).toBinary().length
      )
    }
  )

  it('gives the size SatoshisPerKilobyte charges for', async () => {
    const inputs = [107, 107, 300]
    const outputs = [25, 25, 1]
    const fee = await new SatoshisPerKilobyte(1000).computeFee(builtTransaction(inputs, outputs))
    expect(fee).toBe(transactionSize(inputs, outputs))
  })

  it.each([
    [0, 1],
    [0xfc, 1],
    [0xfd, 3],
    [0xffff, 3],
    [0x10000, 5],
    [0xffffffff, 5],
    [0x100000000, 9],
    [Number.MAX_SAFE_INTEGER, 9]
  ])('encodes %s as a %s-byte VarInt', (value, size) => {
    expect(varUintSize(value)).toBe(size)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects script length %s',
    length => {
      expect(() => transactionSize([length], [])).toThrow(RangeError)
      expect(() => transactionSize([], [length])).toThrow('non-negative safe integer')
    }
  )
})
