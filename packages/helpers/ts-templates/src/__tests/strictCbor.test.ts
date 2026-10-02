import {
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor,
  StrictCborError,
  STRICT_CBOR_MAX_BYTES
} from '../strictCbor.js'

const hex = (h: string): number[] => Array.from(Buffer.from(h.replace(/\s/g, ''), 'hex'))
const toHex = (b: number[]): string => Buffer.from(b).toString('hex')

// The StrictCborError a call throws, so a test can pin its exact message.
const strictCborErrorOf = (call: () => unknown): string => {
  try {
    call()
  } catch (e) {
    expect(e).toBeInstanceOf(StrictCborError)
    return (e as Error).message
  }
  throw new Error('expected a StrictCborError, but nothing was thrown')
}

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
    for (const bad of [1n << 64n, -1n]) {
      expect(strictCborErrorOf(() => encodeStrictCbor({ a: bad }))).toBe(
        'integer outside 0..2^64-1'
      )
    }
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(strictCborErrorOf(() => encodeStrictCbor({ a: bad }))).toBe(
        'number must be a safe non-negative integer'
      )
    }
    expect(toHex(encodeStrictCbor({ a: Number.MAX_SAFE_INTEGER }))).toBe('a161611b001fffffffffffff')
  })
  it('rejects nesting deeper than 4 and accepts exactly 4', () => {
    expect(
      strictCborErrorOf(() => encodeStrictCbor({ a: { b: { c: { d: { e: 1n } } } } } as never))
    ).toBe('map nesting deeper than 4')
    expect(toHex(encodeStrictCbor({ a: { b: { c: { d: 1n } } } } as never))).toBe(
      'a1 6161 a1 6162 a1 6163 a1 6164 01'.replace(/\s/g, '')
    )
  })
  it('rejects values and containers outside the subset instead of coercing them', () => {
    const bad: unknown[] = [undefined, [1], new Date(0), new Map(), new Uint16Array(1), () => 1]
    for (const value of bad) {
      expect(strictCborErrorOf(() => encodeStrictCbor({ a: value as never }))).toBe(
        'unsupported value type'
      )
    }
    for (const top of [[], null, new Uint8Array(1), 'text', 1n]) {
      expect(strictCborErrorOf(() => encodeStrictCbor(top as never))).toBe(
        'top level must be a map'
      )
    }
  })
  it('rejects lone surrogates, which UTF-8 cannot carry', () => {
    const loneSurrogates: Array<Record<string, string | bigint>> = [
      { a: '\ud800' },
      { '\udc00': 1n },
      { a: '\ud800x' },
      { a: 'x\ude00\ud83d' },
      { a: '\ud83d\ude00\ud800' }
    ]
    for (const map of loneSurrogates) {
      expect(strictCborErrorOf(() => encodeStrictCbor(map))).toBe('text contains a lone surrogate')
    }
    expect(toHex(encodeStrictCbor({ a: '😀' }))).toBe('a1 6161 64f09f9880'.replace(/\s/g, ''))
  })
  it('enforces the 4096 byte ceiling', () => {
    expect(encodeStrictCbor({ a: new Uint8Array(4090) })).toHaveLength(STRICT_CBOR_MAX_BYTES)
    expect(strictCborErrorOf(() => encodeStrictCbor({ a: new Uint8Array(4091) }))).toBe(
      'encoding exceeds 4096 bytes'
    )
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
  // [label, hex, message]. The message is a cross-engine contract: the overlay copies it into
  // its deployPayload / detailsSchema reasons, and the Go port must produce the same bytes.
  it.each([
    ['float 1.0', 'a1 6161 fb3ff0000000000000', 'simple value or float not allowed'],
    ['float16', 'a1 6161 f93c00', 'simple value or float not allowed'],
    ['float32', 'a1 6161 fa3f800000', 'simple value or float not allowed'],
    ['tag 42', 'a1 6161 d82a 4100', 'major type 6 not allowed'],
    ['negative int', 'a1 6161 20', 'major type 1 not allowed'],
    ['array', 'a1 6161 8101', 'major type 4 not allowed'],
    ['undefined', 'a1 6161 f7', 'simple value or float not allowed'],
    ['simple value 32', 'a1 6161 f820', 'simple value or float not allowed'],
    ['simple value 20 in the two-byte form', 'a1 6161 f814', 'non-minimal header'],
    ['non-minimal uint', 'a1 6161 1805', 'non-minimal header'],
    ['non-minimal 16-bit uint', 'a1 6161 190005', 'non-minimal header'],
    ['non-minimal 32-bit uint', 'a1 6161 1a0000ffff', 'non-minimal header'],
    ['non-minimal 64-bit uint', 'a1 6161 1b00000000ffffffff', 'non-minimal header'],
    ['non-minimal length', 'b801 6161 01', 'non-minimal header'],
    ['non-minimal key header', 'a1 7801 61 01', 'non-minimal header'],
    [
      'float64 zero (minimality before major type)',
      'a1 6161 fb0000000000000000',
      'non-minimal header'
    ],
    ['float32 zero (minimality before major type)', 'a1 6161 fa00000000', 'non-minimal header'],
    ['float16 zero (minimality before major type)', 'a1 6161 f90000', 'non-minimal header'],
    [
      'non-minimal negative int (minimality before major type)',
      'a1 6161 3800',
      'non-minimal header'
    ],
    ['minimal one-byte negative int', 'a1 6161 38ff', 'major type 1 not allowed'],
    ['indefinite map', 'bf 6161 01 ff', 'indefinite length'],
    ['indefinite text', 'a1 6161 7f6161ff', 'indefinite length'],
    ['indefinite bytes', 'a1 6161 5f4100ff', 'indefinite length'],
    ['break byte as a value', 'a1 6161 ff', 'indefinite length'],
    ['reserved additional info', 'a1 6161 1c', 'reserved additional info'],
    ['reserved additional info 30', 'a1 6161 1e', 'reserved additional info'],
    ['unsorted keys', 'a2 6162 01 6161 01', 'map keys unsorted or duplicated'],
    ['wrong length-first order', 'a2 626161 01 6162 01', 'map keys unsorted or duplicated'],
    ['duplicate keys', 'a2 6161 01 6161 02', 'map keys unsorted or duplicated'],
    ['integer key', 'a1 01 01', 'map key must be text'],
    ['bytes key', 'a1 4161 01', 'map key must be text'],
    [
      'unsorted keys in a nested map',
      'a1 6161 a2 6162 01 6161 01',
      'map keys unsorted or duplicated'
    ],
    [
      'duplicate keys in a nested map',
      'a1 6161 a2 6161 01 6161 02',
      'map keys unsorted or duplicated'
    ],
    ['integer key in a nested map', 'a1 6161 a1 01 01', 'map key must be text'],
    ['bytes key in a nested map', 'a1 6161 a1 4161 01', 'map key must be text'],
    ['a non-text key before its order is judged', 'a2 6162 01 4161 01', 'map key must be text'],
    ['an invalid UTF-8 key before its order is judged', 'a2 6162 01 61ff 01', 'invalid UTF-8'],
    ['top-level not a map', '6161', 'top level must be a map'],
    ['top-level array', '8101', 'top level must be a map'],
    ['empty input', '', 'truncated input'],
    ['trailing byte', 'a1 6161 01 00', 'trailing bytes'],
    ['invalid utf-8', 'a1 6161 61ff', 'invalid UTF-8'],
    ['depth 5', 'a1 6161 a1 6161 a1 6161 a1 6161 a1 6161 01', 'map nesting deeper than 4'],
    [
      'depth 5 before its key',
      'a1 6161 a1 6162 a1 6163 a1 6164 a1 4161',
      'map nesting deeper than 4'
    ],
    [
      'a map count longer than the input, before depth',
      'a1 6161 a1 6162 a1 6163 a1 6164 b8ff',
      'length exceeds input'
    ],
    ['truncated', 'a1 6161', 'truncated input'],
    ['truncated key', 'a1 61', 'truncated input'],
    ['truncated multi-byte header', 'a1 6161 19 01', 'truncated input'],
    ['byte string longer than the input', 'a1 6161 4a 01', 'length exceeds input'],
    ['byte string longer than the rest of the input', 'a1 6161 44 010203', 'truncated input'],
    ['byte string of 2^64-1 bytes', 'a1 6161 5b ffffffffffffffff', 'length exceeds input'],
    ['text of 2^64-1 bytes', 'a1 6161 7b ffffffffffffffff', 'length exceeds input'],
    ['key of 2^64-1 bytes', 'a1 7b ffffffffffffffff', 'length exceeds input'],
    ['map of 2^64-1 entries', 'bb ffffffffffffffff', 'length exceeds input'],
    ['overlong utf-8 c0 80', 'a1 6161 62 c080', 'invalid UTF-8'],
    ['surrogate ed a0 80', 'a1 6161 63 eda080', 'invalid UTF-8'],
    ['code point above U+10FFFF', 'a1 6161 64 f4908080', 'invalid UTF-8'],
    ['truncated utf-8 sequence', 'a1 6161 62 e282', 'invalid UTF-8'],
    ['lone continuation byte', 'a1 6161 61 80', 'invalid UTF-8'],
    ['bad continuation byte', 'a1 6161 62 c241', 'invalid UTF-8'],
    ['five-byte lead', 'a1 6161 65 f888808080', 'invalid UTF-8'],
    ['invalid utf-8 in a key', 'a1 61ff 01', 'invalid UTF-8'],
    ['invalid utf-8 in a nested key', 'a1 6161 a1 61ff 01', 'invalid UTF-8']
  ])('rejects %s', (_label, h, message) => {
    expect(strictCborErrorOf(() => decodeStrictCbor(hex(h)))).toBe(message)
    expect(strictCborErrorOf(() => decodeStrictCbor(Uint8Array.from(hex(h))))).toBe(message)
    expect(tryDecodeStrictCbor(hex(h))).toBeUndefined()
  })
  it('rejects number[] entries outside 0..255 instead of wrapping them', () => {
    // Uint8Array.from would read 0x101 as 0x01 and -1 as 0xff
    for (const input of [
      [0xa1, 0x61, 0x61, 0x101],
      [0xa1, 0x61, 0x61, -0xff],
      [0xa1, 0x61, 0x61, 1.5],
      [0x1a1, 0x61, 0x61, 0x01]
    ]) {
      expect(strictCborErrorOf(() => decodeStrictCbor(input))).toBe('non-canonical encoding')
      expect(tryDecodeStrictCbor(input)).toBeUndefined()
    }
    expect(decodeStrictCbor([0xa1, 0x61, 0x61, 0x01])).toEqual({ a: 1n })
  })
  it('rejects input over 4096 bytes', () => {
    const big = mapWithBytes(4091)
    expect(big).toHaveLength(STRICT_CBOR_MAX_BYTES + 1)
    expect(strictCborErrorOf(() => decodeStrictCbor(big))).toBe('input exceeds 4096 bytes')
    expect(strictCborErrorOf(() => decodeStrictCbor(Uint8Array.from(big)))).toBe(
      'input exceeds 4096 bytes'
    )
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
