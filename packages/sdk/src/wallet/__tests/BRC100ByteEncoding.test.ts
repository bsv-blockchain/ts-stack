import vm from 'node:vm'
import {
  brc100JsonReplacer,
  normalizeBRC100ByteArray,
  normalizeBRC100ByteFields,
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
    expect(normalizeBRC100ByteArray({})).toBeUndefined()
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
    expect(normalizeBRC100ByteArray(new Uint16Array([1]))).toBeUndefined()
    expect(normalizeBRC100ByteArray(new DataView(new ArrayBuffer(1)))).toBeUndefined()
    expect(normalizeBRC100ByteArray(new ArrayBuffer(1))).toBeUndefined()
  })

  it('rejects nullish, primitive, empty, and hostile records without throwing', () => {
    for (const value of [null, undefined, true, false, 0, 1, 'bytes', Symbol('bytes')]) {
      expect(normalizeBRC100ByteArray(value)).toBeUndefined()
      expect(toBRC100PortableByteArray(value)).toBeUndefined()
    }
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile ownKeys')
        }
      }
    )
    expect(normalizeBRC100ByteArray(hostile)).toBeUndefined()
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

  it('rejects top-level values that native JSON cannot serialize', () => {
    expect(() => stringifyBRC100(undefined)).toThrow('BRC-100 JSON payload is not serializable')
    expect(() => stringifyBRC100(Symbol('payload'))).toThrow(
      'BRC-100 JSON payload is not serializable'
    )
  })

  it('keeps the public replacer safe when called without a JSON holder', () => {
    const plain = { 0: 1, 1: 2 }
    expect(
      brc100JsonReplacer.call(null as unknown as Record<string, unknown>, 'data', plain)
    ).toBe(plain)
  })

  it('preserves plain numeric-key objects during serialization, including byte-like field names', () => {
    const tx = JSON.parse(JSON.stringify(new Uint8Array([1, 2, 3])))
    const data = JSON.parse(JSON.stringify(new Uint8Array([4, 5])))

    expect(stringifyBRC100({ tx, data })).toBe('{"tx":{"0":1,"1":2,"2":3},"data":{"0":4,"1":5}}')
  })

  it('normalizes only explicitly selected fields at opaque protocol boundaries', () => {
    const payload = {
      payload: { 0: 1, 1: 2 },
      signature: { 0: 3 },
      hmac: {},
      data: { 0: 4, 1: 5 },
      tx: {}
    }

    expect(normalizeBRC100ByteFields(payload, ['payload', 'signature', 'hmac'])).toBe(payload)
    expect(payload).toEqual({
      payload: [1, 2],
      signature: [3],
      hmac: [],
      data: { 0: 4, 1: 5 },
      tx: {}
    })
  })

  it('does not traverse absent, inherited, invalid, array, or primitive protocol fields', () => {
    const inherited = Object.create({ payload: { 0: 1 } }) as Record<string, unknown>
    inherited.signature = { nope: 1 }
    const array = [{ payload: { 0: 2 } }]

    expect(normalizeBRC100ByteFields(null, ['payload'])).toBeNull()
    expect(normalizeBRC100ByteFields('payload', ['payload'])).toBe('payload')
    expect(normalizeBRC100ByteFields(array, ['payload'])).toBe(array)
    expect(normalizeBRC100ByteFields(inherited, ['payload', 'signature', 'missing'])).toBe(inherited)
    expect(inherited.payload).toEqual({ 0: 1 })
    expect(inherited.signature).toEqual({ nope: 1 })
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

  it('preserves every empty object under a byte-like name while visiting nested byte fields', () => {
    const mangled = (bytes: number[]): Record<string, number> =>
      JSON.parse(JSON.stringify(new Uint8Array(bytes)))
    const result = {
      data: {},
      tx: {},
      signature: {},
      payload: { transaction: mangled([1, 2, 3]) }
    }

    expect(normalizeBRC100WalletByteFields(result)).toEqual({
      data: {},
      tx: {},
      signature: {},
      payload: { transaction: [1, 2, 3] }
    })
    expect(stringifyBRC100(result)).toBe(
      '{"data":{},"tx":{},"signature":{},"payload":{"transaction":[1,2,3]}}'
    )
  })
})
