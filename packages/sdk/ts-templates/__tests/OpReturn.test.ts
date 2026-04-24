import { OpReturn } from '../src/OpReturn'

describe('OpReturn script', () => {
  it('locks OpReturn data', () => {
    expect(new OpReturn().lock('1234').toASM()).toEqual('OP_0 OP_RETURN 31323334')
    expect(new OpReturn().lock(['1234', '5678']).toASM()).toEqual('OP_0 OP_RETURN 31323334 35363738')
  })
  it('does not support unlocking', () => {
    expect(() => new OpReturn().unlock()).toThrow()
  })
})
