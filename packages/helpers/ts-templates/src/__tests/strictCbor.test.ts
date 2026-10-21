import {
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor,
  StrictCborError,
  StrictCborLink,
  STRICT_CBOR_MAX_DEPTH
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

// {a: [[[...]]]}: `levels` nested arrays around the integer 1.
const nestedArrays = (levels: number): number[] => [
  0xa1,
  0x61,
  0x61,
  ...Array.from({ length: levels }, () => 0x81),
  0x01
]

const TOO_DEEP = `nesting deeper than ${STRICT_CBOR_MAX_DEPTH}`

describe('strictCbor encode', () => {
  it('encodes keys length-first and ints minimally (BRC-162 vector)', () => {
    expect(toHex(encodeStrictCbor({ sym: 'USD', dec: 2n }))).toBe('a263646563026373796d63555344')
  })
  it('accepts safe integers as ints and other finite numbers as 64-bit floats', () => {
    expect(encodeStrictCbor({ a: 23 })).toEqual(hex('a1 6161 17'))
    expect(encodeStrictCbor({ a: 24 })).toEqual(hex('a1 6161 1818'))
    expect(encodeStrictCbor({ a: -1 })).toEqual(hex('a1 6161 20'))
    expect(encodeStrictCbor({ a: 1.5 })).toEqual(hex('a1 6161 fb3ff8000000000000'))
    expect(toHex(encodeStrictCbor({ a: Number.MAX_SAFE_INTEGER }))).toBe('a161611b001fffffffffffff')
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(strictCborErrorOf(() => encodeStrictCbor({ a: bad }))).toBe(
        'number must be a safe integer or a finite float'
      )
    }
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
  it('encodes negative integers down to -2^64 and rejects integers outside the range', () => {
    expect(toHex(encodeStrictCbor({ a: -1n }))).toBe('a1616120')
    expect(toHex(encodeStrictCbor({ a: -256n }))).toBe('a1616138ff')
    expect(toHex(encodeStrictCbor({ a: -(1n << 64n) }))).toBe('a161613bffffffffffffffff')
    expect(toHex(encodeStrictCbor({ a: (1n << 64n) - 1n }))).toBe('a161611bffffffffffffffff')
    for (const bad of [1n << 64n, -(1n << 64n) - 1n]) {
      expect(strictCborErrorOf(() => encodeStrictCbor({ a: bad }))).toBe(
        'integer outside -2^64..2^64-1'
      )
    }
  })
  it('encodes bytes, null, booleans and a nested map', () => {
    expect(
      toHex(
        encodeStrictCbor({ b: new Uint8Array([1, 2]), n: null, t: true, f: false, m: { x: 1n } })
      )
    ).toBe('a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5'.replace(/\s/g, ''))
  })
  it('encodes arrays, links and the BRC-162 icon array', () => {
    expect(toHex(encodeStrictCbor({ a: [1n, -1n, 1.5, []] }))).toBe(
      'a1 6161 84 01 20 fb3ff8000000000000 80'.replace(/\s/g, '')
    )
    expect(toHex(encodeStrictCbor({ l: new StrictCborLink(new Uint8Array([0, 1])) }))).toBe(
      'a1 616c d82a 420001'.replace(/\s/g, '')
    )
    expect(toHex(encodeStrictCbor({ icon: ['image/png', new Uint8Array([1, 2])] }))).toBe(
      'a1 6469636f6e 82 69696d6167652f706e67 420102'.replace(/\s/g, '')
    )
    expect(
      strictCborErrorOf(() => encodeStrictCbor({ l: new StrictCborLink(new Uint8Array([1])) }))
    ).toBe('invalid CID')
  })
  it('encodes multi-byte UTF-8 text in values and keys', () => {
    expect(toHex(encodeStrictCbor({ '€': '€' }))).toBe('a1 63e282ac 63e282ac'.replace(/\s/g, ''))
  })
  it(`rejects nesting deeper than ${STRICT_CBOR_MAX_DEPTH} and accepts the bound`, () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 1n
      for (let i = 0; i < levels; i++) value = [value]
      return { a: value }
    }
    expect(encodeStrictCbor(nest(STRICT_CBOR_MAX_DEPTH - 1) as never)).toEqual(
      nestedArrays(STRICT_CBOR_MAX_DEPTH - 1)
    )
    expect(strictCborErrorOf(() => encodeStrictCbor(nest(STRICT_CBOR_MAX_DEPTH) as never))).toBe(
      TOO_DEEP
    )
  })
  it('rejects values and containers outside DAG-CBOR instead of coercing them', () => {
    const bad: unknown[] = [undefined, new Date(0), new Map(), new Uint16Array(1), () => 1]
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
      { a: '😀\ud800' }
    ]
    for (const map of loneSurrogates) {
      expect(strictCborErrorOf(() => encodeStrictCbor(map))).toBe('text contains a lone surrogate')
    }
    expect(toHex(encodeStrictCbor({ a: '😀' }))).toBe('a1 6161 64f09f9880'.replace(/\s/g, ''))
  })
  it('has no size ceiling', () => {
    expect(encodeStrictCbor({ a: new Uint8Array(4091) })).toHaveLength(4097)
  })
})

describe('strictCbor decode accepts exactly strict DAG-CBOR', () => {
  it('round-trips the BRC-162 vector', () => {
    expect(decodeStrictCbor(hex('a263646563026373796d63555344'))).toEqual({ dec: 2n, sym: 'USD' })
  })
  it('decodes integers as bigint over the whole 65-bit range', () => {
    expect(decodeStrictCbor(hex('a161611bffffffffffffffff'))).toEqual({ a: (1n << 64n) - 1n })
    expect(decodeStrictCbor(hex('a1 6161 20'))).toEqual({ a: -1n })
    expect(decodeStrictCbor(hex('a1 6161 38ff'))).toEqual({ a: -256n })
    expect(decodeStrictCbor(hex('a161613bffffffffffffffff'))).toEqual({ a: -(1n << 64n) })
  })
  it('decodes 64-bit floats as numbers', () => {
    expect(decodeStrictCbor(hex('a1 6161 fb3ff8000000000000'))).toEqual({ a: 1.5 })
    expect(decodeStrictCbor(hex('a1 6161 fb0000000000000000'))).toEqual({ a: 0 })
    expect(decodeStrictCbor(hex('a1 6161 fbbff0000000000000'))).toEqual({ a: -1 })
  })
  it('decodes arrays, links and the BRC-162 icon array', () => {
    expect(decodeStrictCbor(hex('a1 6161 84 01 20 fb3ff8000000000000 80'))).toEqual({
      a: [1n, -1n, 1.5, []]
    })
    const { l } = decodeStrictCbor(hex('a1 616c d82a 420001'))
    expect(l).toBeInstanceOf(StrictCborLink)
    expect((l as StrictCborLink).cid).toEqual(new Uint8Array([0, 1]))
    expect(decodeStrictCbor(hex('a1 6469636f6e 82 69696d6167652f706e67 420102'))).toEqual({
      icon: ['image/png', new Uint8Array([1, 2])]
    })
  })
  it('decodes every value kind and a nested map, from number[] and Uint8Array', () => {
    const bytes = hex('a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5')
    const expected = { b: new Uint8Array([1, 2]), f: false, m: { x: 1n }, n: null, t: true }
    expect(decodeStrictCbor(bytes)).toEqual(expected)
    expect(decodeStrictCbor(Uint8Array.from(bytes))).toEqual(expected)
  })
  it('re-encodes whatever it decodes to the identical bytes', () => {
    for (const h of [
      'a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5',
      'a1 6161 84 01 20 fb3ff8000000000000 80',
      'a1 616c d82a 420001',
      'a1 6469636f6e 82 69696d6167652f706e67 420102'
    ]) {
      expect(encodeStrictCbor(decodeStrictCbor(hex(h)))).toEqual(hex(h))
    }
  })
  it('has no size ceiling', () => {
    expect(decodeStrictCbor(mapWithBytes(4091))).toEqual({ a: new Uint8Array(4091) })
  })
  it(`accepts nesting up to ${STRICT_CBOR_MAX_DEPTH} and rejects deeper`, () => {
    const atBound = nestedArrays(STRICT_CBOR_MAX_DEPTH - 1)
    expect(encodeStrictCbor(decodeStrictCbor(atBound))).toEqual(atBound)
    expect(strictCborErrorOf(() => decodeStrictCbor(nestedArrays(STRICT_CBOR_MAX_DEPTH)))).toBe(
      TOO_DEEP
    )
    const maps = hex('a1 6161 a1 6162 a1 6163 a1 6164 a1 6165 01')
    expect(decodeStrictCbor(maps)).toEqual({ a: { b: { c: { d: { e: 1n } } } } })
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
    ['float16', 'a1 6161 f93c00', 'float must be 64-bit'],
    ['float32', 'a1 6161 fa3f800000', 'float must be 64-bit'],
    ['float16 zero', 'a1 6161 f90000', 'float must be 64-bit'],
    ['float32 zero', 'a1 6161 fa00000000', 'float must be 64-bit'],
    ['NaN', 'a1 6161 fb7ff8000000000000', 'non-finite float'],
    ['infinity', 'a1 6161 fb7ff0000000000000', 'non-finite float'],
    ['negative infinity', 'a1 6161 fbfff0000000000000', 'non-finite float'],
    ['a tag other than 42', 'a1 6161 d829 4100', 'only tag 42 is allowed'],
    ['tag 42 wrapping text', 'a1 6161 d82a 6100', 'invalid CID'],
    ['tag 42 wrapping a CID without its multibase prefix', 'a1 6161 d82a 4101', 'invalid CID'],
    ['tag 42 wrapping no bytes', 'a1 6161 d82a 40', 'invalid CID'],
    ['undefined', 'a1 6161 f7', 'simple value not allowed'],
    ['simple value 32', 'a1 6161 f820', 'simple value not allowed'],
    ['simple value 0', 'a1 6161 e0', 'simple value not allowed'],
    ['simple value 20 in the two-byte form', 'a1 6161 f814', 'non-minimal header'],
    ['non-minimal uint', 'a1 6161 1805', 'non-minimal header'],
    ['non-minimal 16-bit uint', 'a1 6161 190005', 'non-minimal header'],
    ['non-minimal 32-bit uint', 'a1 6161 1a0000ffff', 'non-minimal header'],
    ['non-minimal 64-bit uint', 'a1 6161 1b00000000ffffffff', 'non-minimal header'],
    ['non-minimal negative int', 'a1 6161 3800', 'non-minimal header'],
    ['non-minimal length', 'b801 6161 01', 'non-minimal header'],
    ['non-minimal array count', 'a1 6161 9801 01', 'non-minimal header'],
    ['non-minimal key header', 'a1 7801 61 01', 'non-minimal header'],
    ['non-minimal tag', 'a1 6161 d9002a 4100', 'non-minimal header'],
    ['indefinite map', 'bf 6161 01 ff', 'indefinite length'],
    ['indefinite array', 'a1 6161 9f 01 ff', 'indefinite length'],
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
    [
      'a map count longer than the input, before depth',
      'a1 6161 a1 6162 a1 6163 a1 6164 b8ff',
      'length exceeds input'
    ],
    ['truncated', 'a1 6161', 'truncated input'],
    ['truncated key', 'a1 61', 'truncated input'],
    ['truncated multi-byte header', 'a1 6161 19 01', 'truncated input'],
    ['truncated float', 'a1 6161 fb00', 'truncated input'],
    ['truncated array', 'a1 6161 82 01', 'truncated input'],
    ['byte string longer than the input', 'a1 6161 4a 01', 'length exceeds input'],
    ['byte string longer than the rest of the input', 'a1 6161 44 010203', 'truncated input'],
    ['byte string of 2^64-1 bytes', 'a1 6161 5b ffffffffffffffff', 'length exceeds input'],
    ['text of 2^64-1 bytes', 'a1 6161 7b ffffffffffffffff', 'length exceeds input'],
    ['key of 2^64-1 bytes', 'a1 7b ffffffffffffffff', 'length exceeds input'],
    ['map of 2^64-1 entries', 'bb ffffffffffffffff', 'length exceeds input'],
    ['array of 2^64-1 items', 'a1 6161 9b ffffffffffffffff', 'length exceeds input'],
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
      expect(strictCborErrorOf(() => decodeStrictCbor(input))).toBe('input bytes outside 0..255')
      expect(tryDecodeStrictCbor(input)).toBeUndefined()
    }
    expect(decodeStrictCbor([0xa1, 0x61, 0x61, 0x01])).toEqual({ a: 1n })
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
