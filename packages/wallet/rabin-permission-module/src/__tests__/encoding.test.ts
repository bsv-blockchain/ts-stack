import {
  decodeFields,
  decodeKeyResult,
  decodeSignResult,
  digestValue,
  encodeFields,
  PADDING_LIMIT,
  scriptNum,
  scriptNumToBigInt,
  verify
} from '../index.js'
import { fromHex, keyVector, toHex, vectors } from './helpers.js'

describe('BRC-206 result encoding', () => {
  it('encodes minimal non-negative Script numbers', () => {
    expect(toHex(scriptNum(0n))).toBe('')
    expect(toHex(scriptNum(0x7fn))).toBe('7f')
    expect(toHex(scriptNum(0x80n))).toBe('8000')
    expect(toHex(scriptNum(0x8000n))).toBe('008000')
    expect(() => scriptNum(-1n)).toThrow('non-negative bigint')
    expect(() => scriptNum(1 as never)).toThrow('non-negative bigint')
  })

  it('decodes only minimal non-negative Script numbers', () => {
    expect(scriptNumToBigInt([])).toBe(0n)
    expect(scriptNumToBigInt([0x00, 0x80, 0x00])).toBe(0x8000n)
    expect(() => scriptNumToBigInt([0x81])).toThrow('negative Script number')
    expect(() => scriptNumToBigInt([0x00])).toThrow('non-minimal')
    expect(() => scriptNumToBigInt([0x01, 0x00])).toThrow('non-minimal')
  })

  it('frames fields with 2-byte little-endian lengths', () => {
    const fields = [[], [1], Array.from({ length: 300 }, (_, i) => i & 0xff)]
    const encoded = encodeFields(fields)
    expect(encoded.slice(0, 5)).toEqual([0, 0, 1, 0, 1])
    expect(encoded.slice(5, 7)).toEqual([0x2c, 0x01])
    expect(decodeFields(encoded).map(field => Array.from(field))).toEqual(fields)
    expect(() => encodeFields([new Uint8Array(65536)])).toThrow('exceeds 65535 bytes')
    expect(() => decodeFields([1])).toThrow('truncated field length')
    expect(() => decodeFields([2, 0, 1])).toThrow('truncated field value')
  })

  it('decodes key and sign results and rejects the wrong field count', () => {
    const k1 = keyVector('K1 2048 self')
    const s5 = vectors.signatures.find(vector => vector.name.startsWith('S5'))!
    expect(decodeKeyResult(fromHex(k1.response.ciphertext))).toBe(BigInt(`0x${k1.key.n}`))
    expect(decodeSignResult(fromHex(s5.response.ciphertext)).padding).toBe(0n)
    expect(() => decodeKeyResult(fromHex(s5.response.ciphertext))).toThrow('exactly one field')
    expect(() => decodeSignResult(fromHex(k1.response.ciphertext))).toThrow('exactly two fields')
  })

  it('exposes the verifier for applications', () => {
    const s1 = vectors.signatures[0]
    const n = BigInt(`0x${keyVector(s1.keyVector).key.n}`)
    const { sig, padding } = decodeSignResult(fromHex(s1.response.ciphertext))
    expect(PADDING_LIMIT).toBe(65536n)
    expect(digestValue(fromHex(s1.message.hex))).toBe(BigInt(s1.message.h))
    expect(verify(fromHex(s1.message.hex), sig, padding, n)).toBe(true)
  })
})
