import {
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor,
  StrictCborError,
  STRICT_CBOR_MAX_BYTES
} from '../strictCbor.js'

const hex = (h: string): number[] => Array.from(Buffer.from(h.replace(/\s/g, ''), 'hex'))
const toHex = (b: number[]): string => Buffer.from(b).toString('hex')

// a1 6161 59 <len16> <data>: a one-entry map holding a byte string of `dataLength` bytes.
const mapWithBytes = (dataLength: number): number[] => [
  0xa1,
  0x61,
  0x61,
  0x59,
  dataLength >> 8,
  dataLength & 0xff,
  ...Array.from({ length: dataLength }, () => 0)
]

describe('strictCbor encode', () => {
  it('encodes keys length-first and ints minimally (spec §3.5 vector)', () => {
    expect(toHex(encodeStrictCbor({ sym: 'USD', dec: 2n }))).toBe('a263646563026373796d63555344')
  })
  it('accepts safe non-negative numbers as uints', () => {
    expect(encodeStrictCbor({ a: 23 })).toEqual(hex('a1 6161 17'))
    expect(encodeStrictCbor({ a: 24 })).toEqual(hex('a1 6161 1818'))
  })
  it('encodes every uint header width at its boundary', () => {
    const cases: Array<[bigint, string]> = [
      [0n, '00'],
      [255n, '18ff'],
      [256n, '190100'],
      [65535n, '19ffff'],
      [65536n, '1a00010000'],
      [4294967295n, '1affffffff'],
      [4294967296n, '1b0000000100000000']
    ]
    for (const [value, encoded] of cases) {
      expect(toHex(encodeStrictCbor({ a: value }))).toBe(`a16161${encoded}`)
    }
  })
  it('encodes bytes, null, booleans and a nested map', () => {
    expect(
      toHex(
        encodeStrictCbor({ b: new Uint8Array([1, 2]), n: null, t: true, f: false, m: { x: 1n } })
      )
    ).toBe('a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5'.replace(/\s/g, ''))
  })
  it('encodes multi-byte UTF-8 text in values and keys', () => {
    expect(toHex(encodeStrictCbor({ '€': '€' }))).toBe('a1 63e282ac 63e282ac'.replace(/\s/g, ''))
  })
  it('encodes 2^64-1 and rejects 2^64, negatives, unsafe numbers and floats', () => {
    expect(toHex(encodeStrictCbor({ a: (1n << 64n) - 1n }))).toBe('a161611bffffffffffffffff')
    for (const bad of [1n << 64n, -1n, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => encodeStrictCbor({ a: bad as never })).toThrow(StrictCborError)
    }
  })
  it('rejects nesting deeper than 4 and accepts exactly 4', () => {
    expect(() => encodeStrictCbor({ a: { b: { c: { d: { e: 1n } } } } } as never)).toThrow(
      StrictCborError
    )
    expect(toHex(encodeStrictCbor({ a: { b: { c: { d: 1n } } } } as never))).toBe(
      'a1 6161 a1 6162 a1 6163 a1 6164 01'.replace(/\s/g, '')
    )
  })
  it('rejects values and containers outside the subset instead of coercing them', () => {
    const bad: unknown[] = [undefined, [1], new Date(0), new Map(), new Uint16Array(1), () => 1]
    for (const value of bad) {
      expect(() => encodeStrictCbor({ a: value as never })).toThrow(StrictCborError)
    }
    for (const top of [[], null, new Uint8Array(1), 'text', 1n]) {
      expect(() => encodeStrictCbor(top as never)).toThrow(StrictCborError)
    }
  })
  it('rejects lone surrogates, which UTF-8 cannot carry', () => {
    expect(() => encodeStrictCbor({ a: '\ud800' })).toThrow(StrictCborError)
    expect(() => encodeStrictCbor({ '\udc00': 1n })).toThrow(StrictCborError)
    expect(() => encodeStrictCbor({ a: '\ud800x' })).toThrow(StrictCborError)
    expect(() => encodeStrictCbor({ a: 'x\ude00\ud83d' })).toThrow(StrictCborError)
    expect(() => encodeStrictCbor({ a: '\ud83d\ude00\ud800' })).toThrow(StrictCborError)
    expect(toHex(encodeStrictCbor({ a: '😀' }))).toBe('a1 6161 64f09f9880'.replace(/\s/g, ''))
  })
  it('enforces the 4096 byte ceiling', () => {
    expect(encodeStrictCbor({ a: new Uint8Array(4090) })).toHaveLength(STRICT_CBOR_MAX_BYTES)
    expect(() => encodeStrictCbor({ a: new Uint8Array(4091) })).toThrow(StrictCborError)
  })
})

describe('strictCbor decode accepts exactly the subset', () => {
  it('round-trips the spec vector', () => {
    expect(decodeStrictCbor(hex('a263646563026373796d63555344'))).toEqual({ dec: 2n, sym: 'USD' })
  })
  it('decodes 2^64-1 as bigint', () => {
    expect(decodeStrictCbor(hex('a161611bffffffffffffffff'))).toEqual({ a: (1n << 64n) - 1n })
  })
  it('decodes every value kind and a nested map, from number[] and Uint8Array', () => {
    const bytes = hex('a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5')
    const expected = { b: new Uint8Array([1, 2]), f: false, m: { x: 1n }, n: null, t: true }
    expect(decodeStrictCbor(bytes)).toEqual(expected)
    expect(decodeStrictCbor(Uint8Array.from(bytes))).toEqual(expected)
  })
  it('re-encodes whatever it decodes to the identical bytes', () => {
    const bytes = hex('a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5')
    expect(encodeStrictCbor(decodeStrictCbor(bytes))).toEqual(bytes)
  })
  it('accepts exactly 4096 bytes', () => {
    expect(decodeStrictCbor(mapWithBytes(4090))).toEqual({ a: new Uint8Array(4090) })
  })
  it('accepts nesting of exactly depth 4', () => {
    const bytes = hex('a1 6161 a1 6162 a1 6163 a1 6164 01')
    expect(decodeStrictCbor(bytes)).toEqual({ a: { b: { c: { d: 1n } } } })
    expect(encodeStrictCbor(decodeStrictCbor(bytes))).toEqual(bytes)
  })
  it('round-trips a __proto__ key as an ordinary key', () => {
    const encoded = encodeStrictCbor({ ['__proto__']: 1n, a: 2n })
    const decoded = decodeStrictCbor(encoded)
    expect(Object.keys(decoded).sort()).toEqual(['__proto__', 'a'])
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(1n)
    expect(Object.getPrototypeOf(decoded)).toBeNull()
    expect(encodeStrictCbor(decoded)).toEqual(encoded)
  })
  it('round-trips a nested __proto__ key whose value is a map', () => {
    const bytes = hex('a1 695f5f70726f746f5f5f a1 6161 01')
    const decoded = decodeStrictCbor(bytes)
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toEqual({ a: 1n })
    expect(encodeStrictCbor(decoded)).toEqual(bytes)
  })
  it('keeps a leading BOM in text instead of stripping it', () => {
    const bytes = hex('a1 6161 64 efbbbf78')
    expect(decodeStrictCbor(bytes)).toEqual({ a: '﻿x' })
    expect(encodeStrictCbor(decodeStrictCbor(bytes))).toEqual(bytes)
    expect(decodeStrictCbor(hex('a1 64 efbbbf78 01'))).toEqual({ '﻿x': 1n })
  })
  it('decodes valid UTF-8 text including multi-byte sequences', () => {
    expect(decodeStrictCbor(hex('a1 6161 63 e282ac'))).toEqual({ a: '€' })
    expect(decodeStrictCbor(hex('a1 6161 64 f09f9880'))).toEqual({ a: '😀' })
    expect(decodeStrictCbor(hex('a1 6161 62 c2a2'))).toEqual({ a: '¢' })
  })
  it.each([
    ['float 1.0', 'a1 6161 fb3ff0000000000000'],
    ['float16', 'a1 6161 f93c00'],
    ['tag 42', 'a1 6161 d82a 4100'],
    ['negative int', 'a1 6161 20'],
    ['array', 'a1 6161 8101'],
    ['undefined', 'a1 6161 f7'],
    ['simple value 20 in the two-byte form', 'a1 6161 f814'],
    ['non-minimal uint', 'a1 6161 1805'],
    ['non-minimal 16-bit uint', 'a1 6161 190005'],
    ['non-minimal length', 'b801 6161 01'],
    ['indefinite map', 'bf 6161 01 ff'],
    ['indefinite text', 'a1 6161 7f6161ff'],
    ['break byte as a value', 'a1 6161 ff'],
    ['unsorted keys', 'a2 6162 01 6161 01'],
    ['wrong length-first order', 'a2 626161 01 6162 01'],
    ['duplicate keys', 'a2 6161 01 6161 02'],
    ['integer key', 'a1 01 01'],
    ['bytes key', 'a1 4161 01'],
    ['top-level not a map', '6161'],
    ['empty input', ''],
    ['trailing byte', 'a1 6161 01 00'],
    ['invalid utf-8', 'a1 6161 61ff'],
    ['depth 5', 'a1 6161 a1 6161 a1 6161 a1 6161 a1 6161 01'],
    ['truncated', 'a1 6161'],
    ['truncated key', 'a1 61'],
    ['truncated multi-byte header', 'a1 6161 19 01'],
    ['byte string longer than the input', 'a1 6161 4a 01'],
    ['reserved additional info', 'a1 6161 1c'],
    ['overlong utf-8 c0 80', 'a1 6161 62 c080'],
    ['surrogate ed a0 80', 'a1 6161 63 eda080'],
    ['code point above U+10FFFF', 'a1 6161 64 f4908080'],
    ['truncated utf-8 sequence', 'a1 6161 62 e282'],
    ['lone continuation byte', 'a1 6161 61 80'],
    ['bad continuation byte', 'a1 6161 62 c241'],
    ['five-byte lead', 'a1 6161 65 f888808080'],
    ['invalid utf-8 in a key', 'a1 61ff 01']
  ])('rejects %s', (_label, h) => {
    expect(() => decodeStrictCbor(hex(h))).toThrow(StrictCborError)
    expect(tryDecodeStrictCbor(hex(h))).toBeUndefined()
  })
  it('rejects input over 4096 bytes', () => {
    const big = mapWithBytes(4091)
    expect(big).toHaveLength(STRICT_CBOR_MAX_BYTES + 1)
    expect(() => decodeStrictCbor(big)).toThrow(StrictCborError)
    expect(() => decodeStrictCbor(Uint8Array.from(big))).toThrow(StrictCborError)
  })
  it('exposes a named error type', () => {
    let caught: unknown
    try {
      decodeStrictCbor(hex('6161'))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StrictCborError)
    expect((caught as Error).name).toBe('StrictCborError')
  })
  it('tryDecodeStrictCbor returns the map on valid input', () => {
    expect(tryDecodeStrictCbor(hex('a1 6161 01'))).toEqual({ a: 1n })
  })
  it('tryDecodeStrictCbor does not swallow programming errors', () => {
    expect(() => tryDecodeStrictCbor(null as never)).toThrow(TypeError)
  })
})
