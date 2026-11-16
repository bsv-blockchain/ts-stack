import Transaction from '../../transaction/Transaction'
import LockingScript from '../../script/LockingScript'
import UnlockingScript from '../../script/UnlockingScript'

type FixedRandomState = { values: number[]; index: number }

const fixedRandomState = (): FixedRandomState => {
  const state = (globalThis as { __tsStackFixedRandomChange?: FixedRandomState })
    .__tsStackFixedRandomChange
  if (state == null) throw new Error('fixed Random mock was not installed')
  return state
}

jest.mock('../../primitives/Random.js', () => {
  const state: FixedRandomState = { values: [], index: 0 }
  ;(globalThis as { __tsStackFixedRandomChange?: FixedRandomState }).__tsStackFixedRandomChange =
    state
  const random = (len: number): number[] => {
    if (len !== 1) throw new Error(`expected Random(1), received ${String(len)}`)
    if (state.index >= state.values.length) throw new Error('fixed Random source exhausted')
    const byte = state.values[state.index]
    state.index += 1
    return [byte]
  }
  return { __esModule: true, default: random }
})

const CHANGE = 1_000_000

const portionForDigit = (digit: number): number =>
  Math.floor((CHANGE * Math.log10(1 + 1 / digit)) / Math.log10(10))

const useBytes = (values: number[]): void => {
  const state = fixedRandomState()
  state.values = values
  state.index = 0
}

const spendWithTwoChangeOutputs = async (): Promise<Transaction> => {
  const parent = new Transaction()
  parent.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: CHANGE })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript([])
  })
  tx.addOutput({ lockingScript: LockingScript.fromHex('51'), change: true })
  tx.addOutput({ lockingScript: LockingScript.fromHex('51'), change: true })
  await tx.fee(0, 'random')
  return tx
}

const digitOf = (portion: number | undefined): number => {
  for (let digit = 1; digit <= 9; digit++) {
    if (portionForDigit(digit) === portion) return digit
  }
  throw new Error(`portion ${String(portion)} does not match a digit 1..9`)
}

describe('Transaction.fee random change digits', () => {
  afterAll(() => {
    delete (globalThis as { __tsStackFixedRandomChange?: FixedRandomState })
      .__tsStackFixedRandomChange
  })

  it('counts a uniform digit from a fixed Random source that includes bytes >= 252', async () => {
    const portions = new Set<number>()
    for (let digit = 1; digit <= 9; digit++) portions.add(portionForDigit(digit))
    expect(portions.size).toBe(9)

    // Four bytes at or above 252, then one byte of each residue 0..8.
    useBytes([252, 253, 254, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8])
    const digits: number[] = []
    for (let draw = 0; draw < 9; draw++) {
      const tx = await spendWithTwoChangeOutputs()
      expect((tx.outputs[0].satoshis ?? 0) + (tx.outputs[1].satoshis ?? 0)).toBe(CHANGE)
      digits.push(digitOf(tx.outputs[0].satoshis))
    }

    expect(digits).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(fixedRandomState().index).toBe(13)
  })

  it('accepts byte 251 and discards byte 252', async () => {
    useBytes([251])
    const accepted = await spendWithTwoChangeOutputs()
    expect(digitOf(accepted.outputs[0].satoshis)).toBe(9)
    expect(fixedRandomState().index).toBe(1)

    useBytes([252, 8])
    const rejected = await spendWithTwoChangeOutputs()
    expect(digitOf(rejected.outputs[0].satoshis)).toBe(9)
    expect(fixedRandomState().index).toBe(2)
  })
})
