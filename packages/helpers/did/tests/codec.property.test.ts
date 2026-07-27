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

const compactPart = fc.stringMatching(/^[A-Za-z0-9._-]{1,80}$/)

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

  test('round-trips SD-JWT compact fields with and without key binding', () => {
    fc.assert(
      fc.property(
        compactPart,
        fc.array(compactPart, { maxLength: 12 }),
        fc.option(compactPart, { nil: undefined }),
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
