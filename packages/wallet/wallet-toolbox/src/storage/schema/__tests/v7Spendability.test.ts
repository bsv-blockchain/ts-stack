import { isOutputSpendable } from '../v7Spendability'

describe('v7Spendability', () => {
  const tip = { height: 1000 }

  test('non-spendable processing state rejects', () => {
    expect(
      isOutputSpendable({ spentBy: null, lockingScript: [0x76] }, { processing: 'queued' }, tip)
    ).toBe(false)
    expect(
      isOutputSpendable({ spentBy: null, lockingScript: [0x76] }, { processing: 'invalid' }, tip)
    ).toBe(false)
  })

  test('spent output rejects', () => {
    expect(
      isOutputSpendable({ spentBy: 7, lockingScript: [0x76] }, { processing: 'proven' }, tip)
    ).toBe(false)
  })

  test('missing locking script rejects', () => {
    expect(
      isOutputSpendable({ spentBy: null, lockingScript: null }, { processing: 'proven' }, tip)
    ).toBe(false)
  })

  test('immature coinbase rejects', () => {
    expect(
      isOutputSpendable(
        { spentBy: null, lockingScript: [0x76], isCoinbase: true, maturesAtHeight: 1001 },
        { processing: 'proven' },
        tip
      )
    ).toBe(false)
  })

  test('mature coinbase passes', () => {
    expect(
      isOutputSpendable(
        { spentBy: null, lockingScript: [0x76], isCoinbase: true, maturesAtHeight: 1000 },
        { processing: 'proven' },
        tip
      )
    ).toBe(true)
  })

  test('non-coinbase spendable in sent state', () => {
    expect(
      isOutputSpendable(
        { spentBy: null, lockingScript: [0x76], isCoinbase: false },
        { processing: 'sent' },
        tip
      )
    ).toBe(true)
  })

  test('coinbase without chain tip cannot mature', () => {
    expect(
      isOutputSpendable(
        { spentBy: null, lockingScript: [0x76], isCoinbase: true, maturesAtHeight: 100 },
        { processing: 'proven' },
        undefined
      )
    ).toBe(false)
  })
})
