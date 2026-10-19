import { describe, expect, it, jest } from '@jest/globals'
import fc from 'fast-check'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import * as barrel from '../src/index.js'
import {
  CHANNEL_LABEL,
  CHANNEL_PROTOCOL_ID,
  CODE_PREFIX,
  DEFAULTS,
  PAYMENT_PROTOCOL_ID,
  PAYMENT_REQUEST_PROTOCOL_ID,
  RELAY_PROTOCOL_ID,
  SIGNALING_PROTOCOL_ID,
  SIGNALS_MESSAGEBOX,
  isIdentityKey
} from '../src/types.js'
import type {
  IncomingPayment,
  IncomingPaymentRequest,
  PaymentRequestMessage,
  PaymentRequestResponse,
  PaymentToken,
  WalletLike
} from '../src/types.js'
import {
  concatBytes,
  equalBytes,
  fromBase64,
  fromBase64Url,
  fromHex,
  randomBytes,
  toBase64,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode
} from '../src/util/bytes.js'
import { compareCodeUnits } from '../src/util/compare.js'
import { Emitter } from '../src/util/emitter.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { WebRTPayErrorCode } from '../src/util/errors.js'

/** Deterministic non-trivial byte patterns of every length 0..max. */
function patterns(max: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let n = 0; n <= max; n++) {
    out.push(Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11 + 5) & 0xff))
  }
  return out
}

describe('bytes: utf8', () => {
  it('round trips ASCII, multibyte, astral and empty strings', () => {
    for (const s of ['', 'hello', 'héllo wörld', '日本語', 'emoji 🙂🚀', '\u0000\u0001']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s)
    }
    expect(utf8Encode('é')).toEqual(Uint8Array.of(0xc3, 0xa9))
  })

  it('preserves a leading byte order mark', () => {
    const s = '﻿abc'
    expect(utf8Decode(utf8Encode(s))).toBe(s)
  })

  it('throws on invalid UTF-8 instead of substituting', () => {
    expect(() => utf8Decode(Uint8Array.of(0xff, 0xfe))).toThrow(WebRTPayError)
    expect(() => utf8Decode(Uint8Array.of(0xc3))).toThrow(WebRTPayError)
    expect(() => utf8Decode(Uint8Array.of(0xed, 0xa0, 0x80))).toThrow(WebRTPayError)
  })
})

describe('bytes: hex', () => {
  it('round trips every length including empty', () => {
    for (const b of patterns(40)) {
      expect(fromHex(toHex(b))).toEqual(b)
    }
    expect(toHex(new Uint8Array(0))).toBe('')
    expect(fromHex('')).toEqual(new Uint8Array(0))
  })

  it('encodes lowercase and covers all byte values', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(toHex(all)).toBe(Buffer.from(all).toString('hex'))
    expect(toHex(Uint8Array.of(0xab, 0x0f))).toBe('ab0f')
    expect(fromHex(toHex(all))).toEqual(all)
  })

  it('decodes upper and mixed case', () => {
    expect(fromHex('ABcd')).toEqual(Uint8Array.of(0xab, 0xcd))
  })

  it('rejects odd length and non-hex characters', () => {
    expect(() => fromHex('abc')).toThrow(WebRTPayError)
    expect(() => fromHex('zz')).toThrow(WebRTPayError)
    expect(() => fromHex('0x')).toThrow(WebRTPayError)
    expect(() => fromHex('ab cd')).toThrow(WebRTPayError)
    expect(() => fromHex('ab\n')).toThrow(WebRTPayError)
  })
})

describe('bytes: base64', () => {
  it('matches RFC 4648 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy']
    ]
    for (const [plain, encoded] of vectors) {
      expect(toBase64(utf8Encode(plain))).toBe(encoded)
      expect(utf8Decode(fromBase64(encoded))).toBe(plain)
    }
  })

  it('round trips every length 0..64 and agrees with Buffer', () => {
    for (const b of patterns(64)) {
      const encoded = toBase64(b)
      expect(encoded).toBe(Buffer.from(b).toString('base64'))
      expect(fromBase64(encoded)).toEqual(b)
    }
  })

  it('handles a large buffer', () => {
    const big = randomBytes(1 << 20)
    expect(fromBase64(toBase64(big))).toEqual(big)
  })

  it('rejects malformed input strictly', () => {
    expect(() => fromBase64('Zg')).toThrow(WebRTPayError) // missing padding
    expect(() => fromBase64('Zg=')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm9v\n')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm 9v')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zm9')).toThrow(WebRTPayError) // length % 4 != 0
    expect(() => fromBase64('a-b_')).toThrow(WebRTPayError) // url alphabet
    expect(() => fromBase64('Zg==Zg==')).toThrow(WebRTPayError) // padding mid-string
    expect(() => fromBase64('=Zg=')).toThrow(WebRTPayError)
    expect(() => fromBase64('Zh==')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64('Zm9=')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64('Zm9vé')).toThrow(WebRTPayError)
  })
})

describe('bytes: base64url', () => {
  it('round trips every length 0..64 without padding and agrees with Buffer', () => {
    for (const b of patterns(64)) {
      const encoded = toBase64Url(b)
      expect(encoded).toBe(Buffer.from(b).toString('base64url'))
      expect(encoded).not.toContain('=')
      expect(fromBase64Url(encoded)).toEqual(b)
    }
    expect(toBase64Url(new Uint8Array(0))).toBe('')
    expect(fromBase64Url('')).toEqual(new Uint8Array(0))
  })

  it('uses the url-safe alphabet', () => {
    const b = Uint8Array.of(0xfb, 0xff, 0xfe)
    expect(toBase64(b)).toBe('+//+')
    expect(toBase64Url(b)).toBe('-__-')
    expect(fromBase64Url('-__-')).toEqual(b)
  })

  it('rejects the standard alphabet, padding, whitespace and bad lengths', () => {
    expect(() => fromBase64Url('a+b')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('a/b')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zg==')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zm9v ')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zm9v\n')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Z')).toThrow(WebRTPayError) // length % 4 == 1
    expect(() => fromBase64Url('Zm9vY')).toThrow(WebRTPayError)
    expect(() => fromBase64Url('Zh')).toThrow(WebRTPayError) // non-zero trailing bits
    expect(() => fromBase64Url('Zm9vé')).toThrow(WebRTPayError)
  })
})

// The hex and base64 decoders as they were at bd8b26a36, the oracle for the ones in
// src/util/bytes.ts: `codeUnitAt` reads one UTF-16 code unit, as `String#charCodeAt` does
// (NaN past the end), and the padding strip is a function of its own.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function codeUnitAt(s: string, i: number): number {
  return s.slice(i, i + 1).codePointAt(0) ?? Number.NaN
}

function oracleHexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

function oracleFromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new WebRTPayError('protocol', 'Invalid hex: odd length')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hi = oracleHexValue(codeUnitAt(s, 2 * i))
    const lo = oracleHexValue(codeUnitAt(s, 2 * i + 1))
    if (hi < 0 || lo < 0) throw new WebRTPayError('protocol', 'Invalid hex character')
    out[i] = (hi << 4) | lo
  }
  return out
}

function oracleReverseTable(alphabet: string): Int8Array {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < alphabet.length; i++) table[codeUnitAt(alphabet, i)] = i
  return table
}

function oracleUnpaddedEnd(s: string, what: string): number {
  if (s.length % 4 !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: bad length`)
  let end = s.length
  if (end > 0 && codeUnitAt(s, end - 1) === 61) end--
  if (end > 0 && codeUnitAt(s, end - 1) === 61) end--
  return end
}

function oracleDecode(s: string, rev: Int8Array, padded: boolean, what: string): Uint8Array {
  const end = padded ? oracleUnpaddedEnd(s, what) : s.length
  const full = end >> 2
  const rem = end & 3
  if (rem === 1) throw new WebRTPayError('protocol', `Invalid ${what}: bad length`)
  const out = new Uint8Array(full * 3 + (rem === 0 ? 0 : rem - 1))
  const val = (i: number): number => {
    const c = codeUnitAt(s, i)
    const v = c < 128 ? rev[c] : -1
    if (v < 0) throw new WebRTPayError('protocol', `Invalid ${what} character`)
    return v
  }
  let o = 0
  let i = 0
  for (; i < full * 4; i += 4) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3)
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  if (rem === 2) {
    const n = (val(i) << 18) | (val(i + 1) << 12)
    if ((n & 0xffff) !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: trailing bits`)
    out[o++] = n >> 16
  } else if (rem === 3) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6)
    if ((n & 0xff) !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: trailing bits`)
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
  }
  return out
}

const oracleB64Rev = oracleReverseTable(B64_ALPHABET)
const oracleB64UrlRev = oracleReverseTable(B64URL_ALPHABET)
const oracleFromBase64 = (s: string): Uint8Array => oracleDecode(s, oracleB64Rev, true, 'base64')
const oracleFromBase64Url = (s: string): Uint8Array =>
  oracleDecode(s, oracleB64UrlRev, false, 'base64url')

/** The bytes `decode(s)` returns, or the code and message of the `WebRTPayError` it throws. */
function outcome(decode: (s: string) => Uint8Array, s: string): Uint8Array | string {
  try {
    return decode(s)
  } catch (e) {
    if (!(e instanceof WebRTPayError)) throw e
    return `${e.code}: ${e.message}`
  }
}

/** Non-ASCII text: Latin-1, BMP, an astral pair, and lone high and low surrogates. */
const NON_ASCII = ['é', '\u0080', 'ÿ', 'Ā', '😀', '\uD83D', '\uDE00', '\uD800', '\uDFFF', 'Ａ', '￿']

/** One UTF-16 code unit, a lone surrogate included. */
const codeUnit = fc.integer({ min: 0, max: 0xffff }).map(c => String.fromCodePoint(c))

/** Text that is mostly `alphabet` and `=`, with any other code units and code points mixed in. */
function nearly(alphabet: string): fc.Arbitrary<string> {
  return fc.string({
    unit: fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom(...alphabet, '=') },
      { weight: 1, arbitrary: fc.constantFrom(...NON_ASCII) },
      { weight: 1, arbitrary: codeUnit },
      { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) }
    ),
    maxLength: 24
  })
}

/** A valid encoding of random bytes with one character replaced by non-ASCII text. */
function corrupted(encode: (b: Uint8Array) => string): fc.Arbitrary<string> {
  return fc
    .tuple(fc.uint8Array({ minLength: 1, maxLength: 12 }), fc.nat(), fc.constantFrom(...NON_ASCII))
    .map(([bytes, at, ch]) => {
      const s = encode(bytes)
      const i = at % s.length
      return s.slice(0, i) + ch + s.slice(i + 1)
    })
}

describe('bytes: non-ASCII input to the hex and base64 decoders', () => {
  it('is rejected with the same error as before', () => {
    expect(outcome(fromHex, '😀')).toBe('protocol: Invalid hex character')
    expect(outcome(fromHex, 'a\uD800')).toBe('protocol: Invalid hex character')
    expect(outcome(fromHex, '\uDE00a')).toBe('protocol: Invalid hex character')
    expect(outcome(fromHex, 'é')).toBe('protocol: Invalid hex: odd length')
    expect(outcome(fromBase64, 'Zm😀')).toBe('protocol: Invalid base64 character')
    expect(outcome(fromBase64, 'Zm9\uD83D')).toBe('protocol: Invalid base64 character')
    expect(outcome(fromBase64, 'Zg=\uDE00')).toBe('protocol: Invalid base64 character')
    expect(outcome(fromBase64, 'Zm9😀')).toBe('protocol: Invalid base64: bad length')
    expect(outcome(fromBase64Url, 'Zm😀')).toBe('protocol: Invalid base64url character')
    expect(outcome(fromBase64Url, '\uDFFFm9v')).toBe('protocol: Invalid base64url character')
    for (const ch of NON_ASCII) {
      for (const s of [`ab${ch}`, `${ch}ab`, `Zm9v${ch}`, `${ch}Zm9`, `Zg${ch}=`]) {
        expect(outcome(fromHex, s)).toEqual(outcome(oracleFromHex, s))
        expect(outcome(fromBase64, s)).toEqual(outcome(oracleFromBase64, s))
        expect(outcome(fromBase64Url, s)).toEqual(outcome(oracleFromBase64Url, s))
      }
    }
  })

  it('decodes any string exactly as the decoders at bd8b26a36 did', () => {
    fc.assert(
      fc.property(fc.oneof(nearly('0123456789abcdefABCDEF'), corrupted(toHex)), s => {
        expect(outcome(fromHex, s)).toEqual(outcome(oracleFromHex, s))
      }),
      { numRuns: 1000 }
    )
    fc.assert(
      fc.property(fc.oneof(nearly(B64_ALPHABET), corrupted(toBase64)), s => {
        expect(outcome(fromBase64, s)).toEqual(outcome(oracleFromBase64, s))
      }),
      { numRuns: 1000 }
    )
    fc.assert(
      fc.property(fc.oneof(nearly(B64URL_ALPHABET), corrupted(toBase64Url)), s => {
        expect(outcome(fromBase64Url, s)).toEqual(outcome(oracleFromBase64Url, s))
      }),
      { numRuns: 1000 }
    )
  })

  it('agrees with the oracle on valid encodings', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), bytes => {
        expect(fromHex(toHex(bytes))).toEqual(oracleFromHex(toHex(bytes)))
        expect(fromBase64(toBase64(bytes))).toEqual(oracleFromBase64(toBase64(bytes)))
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(oracleFromBase64Url(toBase64Url(bytes)))
      })
    )
  })
})

/** `s` as big-endian UTF-16: byte order is then code unit order, lone surrogates kept. */
function utf16be(s: string): Buffer {
  return Buffer.from(s, 'utf16le').swap16()
}

/** Strings of any UTF-16 code units, including astral pairs and lone surrogates. */
const anyText = fc.oneof(
  fc.string({ unit: codeUnit, maxLength: 6 }),
  fc.string({ unit: 'binary', maxLength: 6 }),
  fc.string({
    unit: fc.constantFrom('a', 'A', 'b', 'f', '0', '9', 'é', '😀', 'Ａ', '\uD800', '\uDFFF'),
    maxLength: 4
  })
)

describe('compareCodeUnits', () => {
  it('orders samples as a sort without a comparator does, by UTF-16 code unit', () => {
    const samples = [
      'b',
      'aa',
      'Ａ',
      'B',
      '9',
      '😀',
      'é',
      '',
      'a',
      '10',
      'A',
      'f',
      '\uD800',
      '\uDFFF',
      'ff',
      'F0'
    ]
    samples.sort(compareCodeUnits)
    // The order `samples.sort()` gave: digits by character, upper case before lower,
    // U+E000..U+FFFF after astral characters (whose high surrogate is smaller).
    expect(samples).toEqual([
      '',
      '10',
      '9',
      'A',
      'B',
      'F0',
      'a',
      'aa',
      'b',
      'f',
      'ff',
      'é',
      '\uD800',
      '😀',
      '\uDFFF',
      'Ａ'
    ])
  })

  it('returns -1, 0 or 1', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1)
    expect(compareCodeUnits('b', 'a')).toBe(1)
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareCodeUnits('a', 'aa')).toBe(-1)
    expect(compareCodeUnits('Z', 'a')).toBe(-1)
  })

  it('agrees with UTF-16 code unit order for any two strings', () => {
    fc.assert(
      fc.property(anyText, anyText, (a, b) => {
        expect(compareCodeUnits(a, b)).toBe(Buffer.compare(utf16be(a), utf16be(b)))
      }),
      { numRuns: 1000 }
    )
  })

  it('sorts any array of strings exactly as a sort without a comparator does', () => {
    fc.assert(
      fc.property(fc.array(anyText, { maxLength: 20 }), xs => {
        const sorted = [...xs]
        sorted.sort(compareCodeUnits)
        expect(sorted).toEqual([...xs].sort())
      })
    )
  })
})

describe('bytes: randomBytes / concatBytes / equalBytes', () => {
  it('returns the requested number of bytes, also beyond the 64 KiB getRandomValues limit', () => {
    expect(randomBytes(0)).toEqual(new Uint8Array(0))
    expect(randomBytes(32)).toHaveLength(32)
    const big = randomBytes(200000)
    expect(big).toHaveLength(200000)
    expect(big.some(v => v !== 0)).toBe(true)
    expect(big.subarray(70000, 70064).some(v => v !== 0)).toBe(true)
  })

  it('produces different output on each call', () => {
    expect(equalBytes(randomBytes(32), randomBytes(32))).toBe(false)
  })

  it('rejects invalid lengths', () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => randomBytes(n)).toThrow(RangeError)
    }
  })

  it('concatenates parts in order and copies', () => {
    expect(concatBytes()).toEqual(new Uint8Array(0))
    const a = Uint8Array.of(1, 2)
    const out = concatBytes(a, new Uint8Array(0), Uint8Array.of(3), Uint8Array.of(4, 5))
    expect(out).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    out[0] = 9
    expect(a[0]).toBe(1)
  })

  it('compares by length and content', () => {
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false)
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false)
    expect(equalBytes(Uint8Array.of(0), new Uint8Array(0))).toBe(false)
  })
})

describe('Emitter', () => {
  type Events = { data: number; done: undefined }

  it('delivers events to listeners and unsubscribes', () => {
    const e = new Emitter<Events>()
    const seen: number[] = []
    const off = e.on('data', v => seen.push(v))
    e.emit('data', 1)
    e.emit('data', 2)
    off()
    e.emit('data', 3)
    expect(seen).toEqual([1, 2])
  })

  it('emits with no listeners without throwing', () => {
    const e = new Emitter<Events>()
    expect(() => e.emit('done', undefined)).not.toThrow()
  })

  it('once fires exactly once', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    e.once('data', fn)
    e.emit('data', 1)
    e.emit('data', 2)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
  })

  it('once can be cancelled before it fires', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    const off = e.once('data', fn)
    off()
    e.emit('data', 1)
    expect(fn).not.toHaveBeenCalled()
  })

  it('treats registering the same function twice as two registrations', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    const off1 = e.on('data', fn)
    e.on('data', fn)
    e.emit('data', 1)
    expect(fn).toHaveBeenCalledTimes(2)
    off1()
    e.emit('data', 2)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('a throwing listener does not stop the others and is reported', () => {
    const errors: Array<[unknown, string]> = []
    const e = new Emitter<Events>((err, event) => errors.push([err, String(event)]))
    const boom = new Error('boom')
    const after = jest.fn()
    e.on('data', () => {
      throw boom
    })
    e.on('data', after)
    expect(() => e.emit('data', 7)).not.toThrow()
    expect(after).toHaveBeenCalledWith(7)
    expect(errors).toEqual([[boom, 'data']])
  })

  it('swallows listener errors when no onListenerError is set', () => {
    const e = new Emitter<Events>()
    const after = jest.fn()
    e.on('data', () => {
      throw new Error('boom')
    })
    e.on('data', after)
    expect(() => e.emit('data', 1)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('survives an onListenerError that itself throws', () => {
    const e = new Emitter<Events>(() => {
      throw new Error('reporter broke')
    })
    const after = jest.fn()
    e.on('data', () => {
      throw new Error('boom')
    })
    e.on('data', after)
    expect(() => e.emit('data', 1)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('reports rejected promises from async listeners', async () => {
    const errors: unknown[] = []
    const e = new Emitter<Events>(err => errors.push(err))
    const boom = new Error('async boom')
    e.on('data', async () => {
      throw boom
    })
    e.emit('data', 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toEqual([boom])
  })

  it('reports rejected promises from async once listeners and never leaks them', async () => {
    const errors: unknown[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const e = new Emitter<Events>(err => errors.push(err))
      const boom = new Error('async once boom')
      e.once('data', async () => {
        throw boom
      })
      e.emit('data', 1)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(errors).toEqual([boom])
      expect(unhandled).toEqual([])
      // still delivered exactly once
      e.emit('data', 2)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(errors).toEqual([boom])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('emits to a snapshot: unsubscribing or subscribing mid-emit is safe', () => {
    const e = new Emitter<Events>()
    const calls: string[] = []
    const offA = e.on('data', () => {
      calls.push('a')
      offA()
      e.on('data', () => calls.push('late'))
    })
    e.on('data', () => calls.push('b'))
    e.emit('data', 1)
    expect(calls).toEqual(['a', 'b'])
    e.emit('data', 2)
    expect(calls).toEqual(['a', 'b', 'b', 'late'])
  })

  it('clear removes every listener', () => {
    const e = new Emitter<Events>()
    const fn = jest.fn()
    e.on('data', fn)
    e.once('done', fn)
    e.clear()
    e.emit('data', 1)
    e.emit('done', undefined)
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps events independent', () => {
    const e = new Emitter<Events>()
    const data = jest.fn()
    e.on('data', data)
    e.emit('done', undefined)
    expect(data).not.toHaveBeenCalled()
  })
})

describe('WebRTPayError', () => {
  it('carries a code, defaults the message to the code and is an Error', () => {
    const err = new WebRTPayError('protocol')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WebRTPayError)
    expect(err.code).toBe('protocol')
    expect(err.message).toBe('protocol')
    expect(err.name).toBe('WebRTPayError')
    expect('cause' in err).toBe(false)
  })

  it('accepts a message and a cause', () => {
    const cause = new Error('inner')
    const err = new WebRTPayError('closed', 'peer went away', { cause })
    expect(err.code).toBe('closed')
    expect(err.message).toBe('peer went away')
    expect(err.cause).toBe(cause)
  })

  it('carries a reason only when one is given', () => {
    const refused = new WebRTPayError('rejected', 'other network', { reason: 'wrong_network' })
    expect(refused.reason).toBe('wrong_network')
    expect('cause' in refused).toBe(false)
    expect('reason' in new WebRTPayError('rejected')).toBe(false)
  })

  it('has a stack trace', () => {
    expect(new WebRTPayError('timeout', 'slow').stack).toContain('slow')
  })

  it('covers the documented error codes', () => {
    const codes: WebRTPayErrorCode[] = [
      'timeout',
      'closed',
      'protocol',
      'auth_failed',
      'peer_unreachable',
      'rejected',
      'invalid_code',
      'invalid_payment',
      'invalid_signal',
      'rate_limited',
      'too_large',
      'unsupported',
      'unavailable'
    ]
    for (const code of codes) expect(new WebRTPayError(code).code).toBe(code)
  })
})

describe('isIdentityKey', () => {
  it('accepts canonical compressed public keys', () => {
    for (let i = 0; i < 25; i++) {
      expect(isIdentityKey(PrivateKey.fromRandom().toPublicKey().toString())).toBe(true)
    }
    // the BRC-100 "anyone" key (private key = 1)
    expect(isIdentityKey(new PrivateKey(1).toPublicKey().toString())).toBe(true)
  })

  it('rejects uppercase hex', () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString()
    expect(isIdentityKey(key.toUpperCase())).toBe(false)
    expect(isIdentityKey(key.slice(0, 2) + key.slice(2).toUpperCase())).toBe(false)
  })

  it('rejects uncompressed 04... keys', () => {
    const uncompressed = PrivateKey.fromRandom().toPublicKey().encode(false, 'hex') as string
    expect(uncompressed).toMatch(/^04[0-9a-f]{128}$/)
    expect(isIdentityKey(uncompressed)).toBe(false)
  })

  it('rejects wrong lengths and prefixes', () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString()
    expect(isIdentityKey(key + '0')).toBe(false) // 67 chars
    expect(isIdentityKey(key.slice(0, 64) + '0')).toBe(false) // 65 chars
    expect(isIdentityKey('0' + key.slice(0, 64))).toBe(false)
    expect(isIdentityKey('')).toBe(false)
    expect(isIdentityKey('05' + key.slice(2))).toBe(false)
    expect(isIdentityKey('00' + key.slice(2))).toBe(false)
    expect(isIdentityKey(' ' + key)).toBe(false)
    expect(isIdentityKey(key + '\n')).toBe(false)
  })

  it('rejects hex that is not a point on the curve', () => {
    expect(isIdentityKey('02' + '0'.repeat(63) + '5')).toBe(false)
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 2, {}, [], Uint8Array.of(2)]) {
      expect(isIdentityKey(v)).toBe(false)
    }
  })

  it('narrows the type', () => {
    const v: unknown = PrivateKey.fromRandom().toPublicKey().toString()
    if (isIdentityKey(v)) {
      const key: string = v
      expect(key).toHaveLength(66)
    } else {
      throw new Error('expected a valid identity key')
    }
  })
})

describe('constants', () => {
  it('pins the wire protocol identifiers', () => {
    expect(PAYMENT_PROTOCOL_ID).toEqual([2, '3241645161d8'])
    expect(CHANNEL_PROTOCOL_ID).toEqual([2, 'webrtpay channel'])
    expect(SIGNALING_PROTOCOL_ID).toEqual([2, 'webrtpay signaling'])
    expect(RELAY_PROTOCOL_ID).toEqual([2, 'webrtpay relay'])
    expect(PAYMENT_REQUEST_PROTOCOL_ID).toEqual([2, 'payment request auth'])
    expect(CHANNEL_LABEL).toBe('webrtpay/1')
    expect(SIGNALS_MESSAGEBOX).toBe('webrtpay_signals')
    expect(CODE_PREFIX).toBe('webrtpay1:')
  })

  it('pins the numeric defaults', () => {
    expect({ ...DEFAULTS }).toEqual({
      chunkBytes: 16384,
      maxMessageBytes: 32 * 1024 * 1024,
      inboundMaxMessageBytes: 16 * 1024 * 1024,
      gatherTimeoutMs: 5000,
      dialGatherTimeoutMs: 1500,
      handshakeTimeoutMs: 15000,
      connectTimeoutMs: 30000,
      presenceTimeoutMs: 2000,
      dialTimeoutMs: 6000,
      ackTimeoutMs: 45000,
      signalMaxSkewMs: 120000,
      payeePollMs: 2500,
      payerPollMs: 1000
    })
  })

  it('freezes the defaults', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('keeps protocol ids usable as wallet protocol tuples', () => {
    // compile-time: WalletProtocol is [SecurityLevel, string]
    const tuples: Array<[0 | 1 | 2, string]> = [
      PAYMENT_PROTOCOL_ID,
      CHANNEL_PROTOCOL_ID,
      SIGNALING_PROTOCOL_ID,
      RELAY_PROTOCOL_ID,
      PAYMENT_REQUEST_PROTOCOL_ID
    ]
    expect(tuples).toHaveLength(5)
  })
})

describe('types', () => {
  it('WalletLike is satisfied by a full WalletInterface', () => {
    // compile-time assertion only; the cast never runs a wallet method
    const full = {} as WalletInterface
    const like: WalletLike = full
    expect(like).toBe(full)
  })

  it('models payment tokens and incoming payments', () => {
    const token: PaymentToken = {
      customInstructions: { derivationPrefix: 'cHJlZml4', derivationSuffix: 'c3VmZml4' },
      transaction: [1, 2, 3],
      amount: 1000
    }
    const withIndex: PaymentToken = { ...token, outputIndex: 1 }
    const incoming: IncomingPayment = {
      messageId: 'm1',
      sender: PrivateKey.fromRandom().toPublicKey().toString(),
      token: withIndex,
      outputIndex: 1
    }
    expect(incoming.token.outputIndex).toBe(1)
  })

  it('discriminates payment request messages on `cancelled`', () => {
    const msgs: PaymentRequestMessage[] = [
      {
        requestId: 'r1',
        senderIdentityKey: 'k',
        amount: 5,
        description: 'coffee',
        expiresAt: 1,
        requestProof: 'p'
      },
      { requestId: 'r1', senderIdentityKey: 'k', cancelled: true, requestProof: 'p' }
    ]
    const kinds = msgs.map(m => (m.cancelled === true ? 'cancel' : `new:${m.amount}`))
    expect(kinds).toEqual(['new:5', 'cancel'])
    const response: PaymentRequestResponse = { requestId: 'r1', status: 'paid', amountPaid: 5 }
    const listed: IncomingPaymentRequest = {
      messageId: 'm',
      sender: 'k',
      requestId: 'r1',
      amount: 5,
      description: 'coffee',
      expiresAt: 1
    }
    expect(response.status).toBe('paid')
    expect(listed.requestId).toBe('r1')
  })
})

describe('root entry', () => {
  it('re-exports the shared types, constants and utilities', () => {
    expect(barrel.VERSION).toBe('0.2.0')
    expect(barrel.WebRTPayError).toBe(WebRTPayError)
    expect(barrel.Emitter).toBe(Emitter)
    expect(barrel.isIdentityKey).toBe(isIdentityKey)
    expect(barrel.DEFAULTS).toBe(DEFAULTS)
    expect(barrel.CHANNEL_LABEL).toBe(CHANNEL_LABEL)
    expect(barrel.CODE_PREFIX).toBe(CODE_PREFIX)
    expect(barrel.toBase64Url).toBe(toBase64Url)
    expect(barrel.randomBytes).toBe(randomBytes)
  })
})
