import { OpReturn } from '../src/OpReturn.js'

describe('OpReturn script', () => {
  it('locks OpReturn data', () => {
    expect(new OpReturn().lock('1234').toASM()).toEqual('OP_0 OP_RETURN 31323334')
    expect(new OpReturn().lock(['1234', '5678']).toASM()).toEqual(
      'OP_0 OP_RETURN 31323334 35363738'
    )
  })
  it('does not support unlocking', () => {
    expect(() => new OpReturn().unlock()).toThrow()
  })

  it('locks and decodes raw byte arrays', () => {
    const script = new OpReturn().lock([65, 66])

    expect(script.toASM()).toBe('OP_0 OP_RETURN 4142')
    expect(OpReturn.decode(script)).toEqual(['AB'])
  })
})
