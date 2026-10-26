import LockingScript from '../../script/LockingScript'
import UnlockingScript from '../../script/UnlockingScript'
import Transaction from '../Transaction'
import MerklePath from '../MerklePath'

const script = (): LockingScript => LockingScript.fromASM('OP_TRUE')

function source(amount: number): Transaction {
  return new Transaction(1, [], [{ lockingScript: script(), satoshis: amount }], 0)
}

function inputFrom(transaction: Transaction, sourceTXID?: string) {
  return {
    sourceTransaction: transaction,
    sourceTXID,
    sourceOutputIndex: 0,
    unlockingScript: UnlockingScript.fromASM('OP_TRUE'),
    sequence: 0xffffffff
  }
}

describe('Transaction value and provenance security', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 21e14 + 1])(
    'rejects an invalid fixed fee of %s',
    async invalidFee => {
      const transaction = new Transaction(
        1,
        [inputFrom(source(10))],
        [{ lockingScript: script(), change: true }],
        0
      )
      await expect(transaction.fee(invalidFee)).rejects.toThrow('non-negative safe integer')
    }
  )

  it('rejects invalid fees returned by custom models', async () => {
    const transaction = new Transaction(
      1,
      [inputFrom(source(10))],
      [{ lockingScript: script(), change: true }],
      0
    )
    await expect(transaction.fee({ computeFee: async () => Number.NaN })).rejects.toThrow(
      'non-negative safe integer'
    )
  })

  it('rejects amounts and totals outside the monetary range', async () => {
    const badSource = source(Number.NaN)
    const fromBadSource = new Transaction(
      1,
      [inputFrom(badSource)],
      [{ lockingScript: script(), change: true }],
      0
    )
    await expect(fromBadSource.fee(0)).rejects.toThrow('source amount')

    const badOutput = new Transaction(
      1,
      [inputFrom(source(10))],
      [{ lockingScript: script(), satoshis: -1 }],
      0
    )
    await expect(badOutput.fee(0)).rejects.toThrow('Output 0 amount')
    await expect(badOutput.sign()).rejects.toThrow('Output 0 amount')
  })

  it('rejects an absent source output and insufficient funds', async () => {
    const missing = new Transaction(
      1,
      [{ ...inputFrom(source(10)), sourceOutputIndex: 1 }],
      [{ lockingScript: script(), change: true }],
      0
    )
    await expect(missing.fee(0)).rejects.toThrow('does not exist')

    const overspend = new Transaction(
      1,
      [inputFrom(source(10))],
      [{ lockingScript: script(), satoshis: 9, change: false }],
      0
    )
    await expect(overspend.fee(2)).rejects.toThrow('insufficient')
  })

  it('never credits undistributed change to a recipient output', async () => {
    const recipient = { lockingScript: script(), satoshis: 1, change: false }
    const transaction = new Transaction(1, [inputFrom(source(10))], [recipient], 0)

    await transaction.fee(2)

    expect(recipient.satoshis).toBe(1)
    expect(transaction.getFee()).toBe(9)
  })

  it('credits equal-distribution rounding only to a designated change output', async () => {
    const firstChange = { lockingScript: script(), change: true }
    const secondChange = { lockingScript: script(), change: true }
    const recipient = { lockingScript: script(), satoshis: 1, change: false }
    const transaction = new Transaction(
      1,
      [inputFrom(source(10))],
      [firstChange, secondChange, recipient],
      0
    )

    await transaction.fee(0, 'equal')

    expect(transaction.outputs[0].satoshis).toBe(4)
    expect(transaction.outputs[1].satoshis).toBe(5)
    expect(recipient.satoshis).toBe(1)
  })

  it('does not mint value when random distribution has more outputs than satoshis', async () => {
    const changeOutputs = Array.from({ length: 5 }, () => ({
      lockingScript: script(),
      change: true
    }))
    const transaction = new Transaction(1, [inputFrom(source(2))], changeOutputs, 0)

    await transaction.fee(0, 'random')

    expect(transaction.outputs.reduce((sum, output) => sum + (output.satoshis ?? 0), 0)).toBe(2)
  })

  it('rejects malformed addInput and addOutput values', () => {
    const transaction = new Transaction()
    expect(() =>
      transaction.addInput({
        sourceTXID: 'not-a-txid',
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromASM('OP_TRUE')
      })
    ).toThrow('32-byte hexadecimal')
    expect(() => transaction.addOutput({ lockingScript: script(), satoshis: 1.5 })).toThrow(
      'non-negative safe integer'
    )
  })

  it('rejects duplicate outpoints during unmined verification', async () => {
    const sourceTransaction = source(2)
    const sourceTXID = sourceTransaction.id('hex')
    const repeated = inputFrom(sourceTransaction, sourceTXID)
    const transaction = new Transaction(
      1,
      [repeated, { ...repeated }],
      [{ lockingScript: script(), satoshis: 1 }],
      0
    )

    await expect(transaction.verify('scripts only')).rejects.toThrow('more than once')
  })

  it('rejects structurally invalid unmined transactions before script acceptance', async () => {
    await expect(new Transaction().verify('scripts only')).rejects.toThrow('has no inputs')

    const noOutputs = new Transaction(1, [inputFrom(source(1))], [], 0)
    await expect(noOutputs.verify('scripts only')).rejects.toThrow('has no outputs')

    const negativeOutput = new Transaction(
      1,
      [inputFrom(source(1))],
      [{ lockingScript: script(), satoshis: -1 }],
      0
    )
    await expect(negativeOutput.verify('scripts only')).rejects.toThrow('Output 0 amount')
  })

  it('binds a supplied source transaction to the serialized outpoint during full verification', async () => {
    const sourceTransaction = source(2)
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTransaction.id('hex'),
      1
    )
    const transaction = new Transaction(
      1,
      [inputFrom(sourceTransaction, '11'.repeat(32))],
      [{ lockingScript: script(), satoshis: 1 }],
      0
    )

    await expect(transaction.verify({} as any)).rejects.toThrow(
      'does not reference its supplied source transaction'
    )
  })

  it('refuses to sign a mismatched complete source transaction', async () => {
    const completeSource = source(2)
    completeSource.addInput({
      sourceTXID: '22'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromASM('OP_TRUE')
    })
    const transaction = new Transaction(
      1,
      [inputFrom(completeSource, '11'.repeat(32))],
      [{ lockingScript: script(), satoshis: 1 }],
      0
    )

    await expect(transaction.sign()).rejects.toThrow(
      'sourceTXID does not reference its supplied source transaction'
    )
  })

  it('refuses to format a preimage for a mismatched source transaction', () => {
    const sourceTransaction = source(2)
    const transaction = new Transaction(
      1,
      [inputFrom(sourceTransaction, '11'.repeat(32))],
      [{ lockingScript: script(), satoshis: 1 }],
      0
    )

    expect(() => transaction.preimage(0)).toThrow('sourceTXID does not match sourceTransaction')
    expect(() => transaction.preimage(Number.NaN)).toThrow('Invalid input index')
  })
})
