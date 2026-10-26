import fc from 'fast-check'

import {
  base64UrlDecode,
  base64UrlDecodeJson,
  base64UrlEncode,
  base64UrlEncodeJson
} from '../src/utils/base64url.js'
import { decodeBase58Multibase, encodeBase58Multibase } from '../src/utils/multibase.js'
import { parseSdJwt, serializeSdJwt } from '../src/sd-jwt/format.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const compactPart = fc.stringMatching(/^[A-Za-z0-9_-]{1,80}$/)
const compactJwt = fc.tuple(compactPart, compactPart, compactPart).map(parts => parts.join('.'))
const MAX_CODEC_BYTES = 1_048_576

describe('DID and SD-JWT codec properties', () => {
  test('round-trips arbitrary bytes through canonical base64url encoding', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), bytes => {
        const input = Array.from(bytes)
        const base64url = base64UrlEncode(input)

        expect(base64url).toMatch(/^[A-Za-z0-9_-]*$/)
        expect(base64UrlDecode(base64url)).toEqual(input)
      })
    )
  })

  test('round-trips arbitrary non-empty bytes through base58-btc multibase', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), bytes => {
        const input = Array.from(bytes)
        expect(decodeBase58Multibase(encodeBase58Multibase(input))).toEqual(input)
      })
    )
  })

  test('round-trips arbitrary JSON values without changing their structure', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const canonical = JSON.parse(JSON.stringify(value))
        expect(base64UrlDecodeJson(base64UrlEncodeJson(value))).toEqual(canonical)
      })
    )
  })

  test('rejects malformed base64url alphabets and impossible lengths', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.constantFrom('+', '/', '=', ' ', '\n'),
        (prefix, invalid) => {
          expect(() => base64UrlDecode(`${prefix}${invalid}`)).toThrow('Invalid base64url')
        }
      )
    )
    expect(() => base64UrlDecode('a')).toThrow('Invalid base64url')
    expect(() => base64UrlDecode('Zh')).toThrow('Invalid base64url')
    expect(() => base64UrlDecode('Zm9')).toThrow('Invalid base64url')
  })

  test('enforces base64url input types and exact byte-limit boundaries', () => {
    const maximumEncodedLength = Math.ceil(MAX_CODEC_BYTES / 3) * 4

    expect(base64UrlEncode('')).toBe('')
    expect(base64UrlEncode('f')).toBe('Zg')
    expect(base64UrlDecode('', 0)).toEqual([])
    expect(base64UrlDecode('Zg', 1)).toEqual([102])
    expect(base64UrlDecode('Zg', 3)).toEqual([102])
    expect(() => base64UrlDecode('Zm8', 1)).toThrow('base64url value exceeds the byte limit')
    expect(() => base64UrlEncode('a'.repeat(MAX_CODEC_BYTES + 1))).toThrow(
      'text value has an invalid length'
    )
    expect(() => base64UrlDecode('A'.repeat(maximumEncodedLength + 4))).toThrow(
      'base64url value has an invalid length'
    )
    expect(() => base64UrlDecode(1 as unknown as string)).toThrow(
      'base64url value must be a string'
    )

    for (const maximumBytes of [-1, 1.5, MAX_CODEC_BYTES + 1]) {
      expect(() => base64UrlDecode('', maximumBytes)).toThrow('maximumBytes must be 0..1048576')
    }
  })

  test('rejects invalid UTF-8 and empty JSON with their precise codec errors', () => {
    const invalidUtf8 = base64UrlEncode([0xc3, 0x28])

    expect(() => base64UrlDecodeJson(invalidUtf8)).toThrow('JSON value is not valid UTF-8')
    expect(() => base64UrlDecodeJson('')).toThrow('JSON value is not canonical JSON')
    expect(() => base64UrlEncodeJson(Symbol('not-json'))).toThrow(
      'JSON value contains a non-JSON value'
    )
    expect(() =>
      base64UrlEncodeJson(Array.from({ length: 19_999 }, () => 123_456_789_012_345))
    ).toThrow('JSON serialization has an invalid length')
  })

  test('rejects malformed and oversized base58-btc multibase values precisely', () => {
    expect(() => decodeBase58Multibase(1 as unknown as string)).toThrow(
      'Multibase value must be a string'
    )
    expect(() => encodeBase58Multibase([256])).toThrow('Multibase input[0] must be a byte')
    expect(() => decodeBase58Multibase('x1')).toThrow('Only base58-btc multibase is supported')
    expect(() => decodeBase58Multibase('z0A')).toThrow('Invalid base58-btc multibase value')
    expect(() => decodeBase58Multibase('zA0')).toThrow('Invalid base58-btc multibase value')
    expect(() => decodeBase58Multibase(`z${'1'.repeat(MAX_CODEC_BYTES + 1)}`)).toThrow(
      'Multibase value exceeds the limit'
    )
  })

  test('rejects base58-btc text when a decoder normalizes its accepted spelling', () => {
    const matchDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'match')
    const originalMatch = String.prototype.match
    Object.defineProperty(String.prototype, 'match', {
      ...matchDescriptor,
      value(this: string, matcher: RegExp): RegExpMatchArray | null {
        if (String(this) === '1' && matcher instanceof RegExp && matcher.source === '^1+')
          return null
        return originalMatch.call(this, matcher)
      }
    })
    try {
      expect(() => decodeBase58Multibase('z1')).toThrow('Noncanonical base58-btc multibase value')
    } finally {
      Object.defineProperty(String.prototype, 'match', matchDescriptor ?? { value: originalMatch })
    }
  })

  test('round-trips SD-JWT compact fields with and without key binding', () => {
    fc.assert(
      fc.property(
        compactJwt,
        fc.array(compactPart, { maxLength: 12 }),
        fc.option(compactJwt, { nil: undefined }),
        (issuerSignedJwt, disclosures, kbJwt) => {
          const encoded = serializeSdJwt(issuerSignedJwt, disclosures, kbJwt)
          expect(parseSdJwt(encoded)).toEqual({
            issuerSignedJwt,
            disclosures,
            ...(kbJwt === undefined ? {} : { kbJwt })
          })
        }
      )
    )
  })
})
