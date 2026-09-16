import { describe, expect, it } from 'vitest'
import {
  bytesEqual,
  concat,
  fromHex,
  fromNumbers,
  randomId,
  toHex,
  toNumbers,
  utf8
} from '../bytes.js'

describe('toHex', () => {
  it('pads each byte to two digits and emits lower case', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff')
  })

  it('accepts a number[] as well as a Uint8Array', () => {
    expect(toHex([2, 170, 255])).toBe('02aaff')
  })

  it('is empty for empty input', () => {
    expect(toHex(new Uint8Array())).toBe('')
  })
})

describe('fromHex', () => {
  it('round-trips with toHex', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
    expect(fromHex(toHex(bytes))).toEqual(bytes)
  })

  it('round-trips a 33-byte compressed identity key', () => {
    const hex = `02${'ab'.repeat(32)}`
    expect(toHex(fromHex(hex))).toBe(hex)
  })

  it('returns an empty array for an empty string', () => {
    expect(fromHex('')).toEqual(new Uint8Array())
  })

  it('accepts upper case digits', () => {
    expect(fromHex('ABcdEF')).toEqual(new Uint8Array([0xab, 0xcd, 0xef]))
  })

  it('throws on odd-length input', () => {
    expect(() => fromHex('abc')).toThrow('Odd-length hex string: 3')
  })

  it('throws on a wholly non-hex pair', () => {
    expect(() => fromHex('zz')).toThrow('Invalid hex at offset 0')
  })

  it('reports the offset of the first bad pair', () => {
    expect(() => fromHex('00112z44')).toThrow('Invalid hex at offset 4')
  })

  // parseInt stops at the first unparseable character, so a trailing non-hex
  // digit used to be silently dropped and the pair decoded from its prefix.
  it('throws on a pair whose second digit is not hex', () => {
    expect(() => fromHex('1z')).toThrow('Invalid hex at offset 0')
  })

  // "0x12" splits into "0x" and "12"; parseInt("0x", 16) is NaN.
  it('rejects a 0x prefix', () => {
    expect(() => fromHex('0x12')).toThrow('Invalid hex at offset 0')
  })

  // parseInt skips leading whitespace and honours a sign, so these used to
  // decode — "-1" as -1, which a Uint8Array then wraps to 255.
  it('rejects whitespace', () => {
    expect(() => fromHex(' 1')).toThrow('Invalid hex at offset 0')
    expect(() => fromHex('1 ')).toThrow('Invalid hex at offset 0')
  })

  it('rejects a signed pair rather than wrapping it', () => {
    expect(() => fromHex('-1')).toThrow('Invalid hex at offset 0')
    expect(() => fromHex('+1')).toThrow('Invalid hex at offset 0')
  })
})

describe('toNumbers / fromNumbers', () => {
  it('round-trip', () => {
    const numbers = [0, 42, 255]
    expect(toNumbers(fromNumbers(numbers))).toEqual(numbers)
  })

  it('copies rather than aliasing', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const numbers = toNumbers(bytes)
    bytes[0] = 9
    expect(numbers[0]).toBe(1)
  })
})

describe('concat', () => {
  it('joins parts in order', () => {
    expect(concat(new Uint8Array([1, 2]), new Uint8Array([3]))).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('ignores empty parts and returns empty for no parts', () => {
    expect(concat()).toEqual(new Uint8Array())
    expect(concat(new Uint8Array(), new Uint8Array([7]), new Uint8Array())).toEqual(
      new Uint8Array([7])
    )
  })
})

describe('utf8', () => {
  it('encodes multi-byte characters', () => {
    expect(toHex(utf8('é'))).toBe('c3a9')
    expect(utf8('')).toEqual(new Uint8Array())
  })
})

describe('bytesEqual', () => {
  it('is true for equal contents in distinct arrays', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })

  it('is false for different lengths', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('is false for the same length with differing content', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })

  it('detects a difference in the first byte', () => {
    expect(bytesEqual(new Uint8Array([0, 0, 0]), new Uint8Array([1, 0, 0]))).toBe(false)
  })

  it('detects a single-bit difference', () => {
    expect(bytesEqual(new Uint8Array([0x80]), new Uint8Array([0x00]))).toBe(false)
  })

  it('is true for two empty arrays', () => {
    expect(bytesEqual(new Uint8Array(), new Uint8Array())).toBe(true)
  })

  // The comparison accumulates XOR over every byte and only branches on
  // length, so it does not leak the position of the first differing byte.
  // It is not a hardened constant-time primitive; the doc comment says so.
  it('does not short-circuit on the first differing byte', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([9, 2, 3, 4])
    expect(bytesEqual(a, b)).toBe(false)
    expect(bytesEqual(b, a)).toBe(false)
  })
})

describe('randomId', () => {
  it('is 32 lower-case hex characters', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()))
    expect(ids.size).toBe(100)
  })
})
