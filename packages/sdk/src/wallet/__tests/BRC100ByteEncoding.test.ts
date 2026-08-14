import vm from 'node:vm'
import {
  brc100JsonReplacer,
  normalizeBRC100ByteArray,
  normalizeBRC100WalletByteFields,
  stringifyBRC100,
  toBRC100PortableByteArray
} from '../BRC100ByteEncoding'

const sparseBytes = [0, 1, 2]
delete sparseBytes[1]

describe('BRC-100 byte encoding', () => {
  it('preserves validated number[] and Uint8Array fast paths by identity', () => {
    const array = [0, 1, 254, 255]
    const typed = new Uint8Array(array)

    expect(normalizeBRC100ByteArray(array)).toBe(array)
    expect(normalizeBRC100ByteArray(typed)).toBe(typed)
  })

  it('accepts cross-realm Uint8Array without copying', () => {
    const typed = vm.runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array
    expect(normalizeBRC100ByteArray(typed)).toBe(typed)
  })

  it('accepts Uint8Array subclasses without copying', () => {
    class WalletBytes extends Uint8Array {}
    const typed = new WalletBytes([1, 2, 3])
    expect(normalizeBRC100ByteArray(typed)).toBe(typed)
  })

  it('recovers contiguous numeric-key JSON objects independent of insertion order', () => {
    const numericObject = JSON.parse('{"2":3,"0":1,"1":2}')
    expect(normalizeBRC100ByteArray(numericObject)).toEqual([1, 2, 3])
    expect(normalizeBRC100ByteArray({})).toEqual([])
  })

  it.each([
    [sparseBytes, 'sparse array'],
    [[-1], 'negative byte'],
    [[256], 'oversized byte'],
    [[1.5], 'fractional byte'],
    [{ 0: 1, 2: 3 }, 'non-contiguous object'],
    [{ 0: '1' }, 'non-numeric object'],
    ['1,2,3', 'string']
  ])('rejects %s (%s)', value => {
    expect(normalizeBRC100ByteArray(value)).toBeUndefined()
  })

  it('rejects non-Uint8 typed arrays', () => {
    expect(normalizeBRC100ByteArray(new Int8Array([1]))).toBeUndefined()
  })

  it('only allocates when a portable array is required', () => {
    const array = [1, 2, 3]
    const typed = new Uint8Array(array)

    expect(toBRC100PortableByteArray(array)).toBe(array)
    expect(toBRC100PortableByteArray(typed)).toEqual(array)
    expect(toBRC100PortableByteArray(typed)).not.toBe(typed)
  })

  it('serializes nested typed arrays as JSON arrays', () => {
    const payload = { result: { signableTransaction: { tx: new Uint8Array([1, 2]) } } }
    const expected = '{"result":{"signableTransaction":{"tx":[1,2]}}}'

    expect(JSON.stringify(payload, brc100JsonReplacer)).toBe(expected)
    expect(stringifyBRC100(payload)).toBe(expected)
  })

  it('serializes Node Buffer values as portable arrays despite Buffer.toJSON', () => {
    const payload = { tx: Buffer.from([1, 2, 3]) }
    expect(stringifyBRC100(payload)).toBe('{"tx":[1,2,3]}')
  })

  it('repairs historical numeric-key wallet byte fields during serialization', () => {
    const tx = JSON.parse(JSON.stringify(new Uint8Array([1, 2, 3])))
    const unrelated = JSON.parse(JSON.stringify(new Uint8Array([4, 5])))

    expect(stringifyBRC100({ tx, unrelated })).toBe('{"tx":[1,2,3],"unrelated":{"0":4,"1":5}}')
  })

  it('repairs all known nested wallet byte fields and leaves unrelated records alone', () => {
    const mangled = (bytes: number[]): Record<string, number> =>
      JSON.parse(JSON.stringify(new Uint8Array(bytes)))
    const unrelated = mangled([9, 8])
    const result = {
      tx: mangled([1]),
      signableTransaction: { tx: mangled([2]) },
      page: { BEEF: mangled([3]) },
      reviewActionResults: [{ competingBeef: mangled([4]) }],
      crypto: { ciphertext: mangled([5]), signature: mangled([6]) },
      message: { transaction: mangled([7]), beef: mangled([8]), atomicBEEF: mangled([9]) },
      unrelated
    }

    expect(normalizeBRC100WalletByteFields(result)).toBe(result)
    expect(result.tx).toEqual([1])
    expect(result.signableTransaction.tx).toEqual([2])
    expect(result.page.BEEF).toEqual([3])
    expect(result.reviewActionResults[0].competingBeef).toEqual([4])
    expect(result.crypto).toEqual({ ciphertext: [5], signature: [6] })
    expect(result.message).toEqual({ transaction: [7], beef: [8], atomicBEEF: [9] })
    expect(result.unrelated).toBe(unrelated)
  })

  it('preserves generic empty data and payload containers while visiting nested byte fields', () => {
    const mangled = (bytes: number[]): Record<string, number> =>
      JSON.parse(JSON.stringify(new Uint8Array(bytes)))
    const result = {
      data: {},
      payload: { transaction: mangled([1, 2, 3]) }
    }

    expect(normalizeBRC100WalletByteFields(result)).toEqual({
      data: {},
      payload: { transaction: [1, 2, 3] }
    })
    expect(stringifyBRC100(result)).toBe('{"data":{},"payload":{"transaction":[1,2,3]}}')
  })
})
