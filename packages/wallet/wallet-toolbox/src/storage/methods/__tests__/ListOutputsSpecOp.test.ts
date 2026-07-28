import { specOpWalletBalance } from '../../../sdk/types'
import { getListOutputsSpecOp } from '../ListOutputsSpecOp'

describe('getListOutputsSpecOp', () => {
  it('returns the ordinary operation when no basket or intercepted tag is present', () => {
    expect(getListOutputsSpecOp('', [])).toEqual({
      specOp: undefined,
      basket: '',
      tags: []
    })
    expect(getListOutputsSpecOp('application', ['ordinary'])).toEqual({
      specOp: undefined,
      basket: 'application',
      tags: ['ordinary']
    })
  })

  it('resolves a basket operation and normalizes missing tags', () => {
    const result = getListOutputsSpecOp(specOpWalletBalance, undefined as never)

    expect(result.specOp?.name).toBe('totalOutputsIsWalletBalance')
    expect(result.basket).toBe('default')
    expect(result.tags).toEqual([])
  })

  it('resolves the wallet-balance tag for the default basket', () => {
    const result = getListOutputsSpecOp('default', [
      'ordinary',
      specOpWalletBalance,
      'remaining'
    ])

    expect(result.specOp).toMatchObject({
      name: 'totalOutputsIsWalletBalance',
      managedChangeOnly: true
    })
    expect(result.basket).toBe('default')
    expect(result.tags).toEqual(['ordinary', 'remaining'])
  })

  it('preserves application-basket balance-tag behavior', () => {
    const result = getListOutputsSpecOp('application', [specOpWalletBalance])

    expect(result.specOp).toMatchObject({
      name: 'totalOutputsIsWalletBalance'
    })
    expect(result.specOp?.managedChangeOnly).toBeUndefined()
    expect(result.basket).toBe('application')
    expect(result.tags).toEqual([])
  })

  it('handles a missing tag collection without changing an unknown basket', () => {
    expect(getListOutputsSpecOp('application', undefined as never)).toEqual({
      specOp: undefined,
      basket: 'application',
      tags: undefined
    })
  })
})
