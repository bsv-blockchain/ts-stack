import { jest } from '@jest/globals'
import { PublicKey } from '@bsv/sdk/primitives'
import { base64UrlDecode, base64UrlEncode } from '../src/utils/base64url.js'
import {
  decodeDidKey,
  didFromVerificationMethod,
  encodeBase58Multibase,
  normalizePublicKey,
  publicKeyToDidKey
} from '../src/utils/multibase.js'

// Fixed public BRC-202 vector; all production calls occur inside individual tests.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const MATERIAL = 'zQ3shVc2UkAfJCdc1TR8E66J85h48P43r93q8jGPkPpjF9Ef9'
const DID = `did:key:${MATERIAL}`

function keyBytes(): number[] {
  return Array.from({ length: 33 }, (_, index) => parseInt(KEY.slice(index * 2, index * 2 + 2), 16))
}

describe('codec public input boundaries', () => {
  test.each([` ${KEY}`, `${KEY} `, `x${KEY}`, `${KEY}x`, KEY.slice(2), `${KEY}00`])(
    'rejects non-exact compressed hexadecimal spelling %s before parsing',
    input => {
      expect(() => publicKeyToDidKey(input)).toThrow(
        'Identity key must be exactly 33 compressed hex bytes'
      )
    }
  )

  test('byte-array validation retains its public error context', () => {
    expect(() => publicKeyToDidKey([256, ...keyBytes().slice(1)])).toThrow(
      'Identity key[0] must be a byte'
    )
    expect(() => base64UrlEncode([256])).toThrow('bytes[0] must be a byte')
  })

  test.each([0x00, 0x01, 0x04, 0x06, 0x07])('rejects compressed prefix %i precisely', prefix => {
    expect(() => publicKeyToDidKey([prefix, ...keyBytes().slice(1)])).toThrow(
      'Identity key must have compressed prefix 02 or 03'
    )
  })

  test.each([
    'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f',
    'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30'
  ])('rejects x at or above the secp256k1 field bound %s before SDK parsing', x => {
    expect(() => publicKeyToDidKey(`02${x}`)).toThrow(
      'Identity key x coordinate outside secp256k1 field'
    )
  })

  test('rejects empty verification-method fragment with the fragment-specific error', () => {
    expect(() => didFromVerificationMethod(`${DID}#`)).toThrow(
      'Verification method must be a DID URL with a fragment'
    )
  })

  test('rejects truncated DID material with the key-length error', () => {
    const did = `did:key:${encodeBase58Multibase([0xe7, 0x01, ...keyBytes().slice(1)])}`
    expect(() => decodeDidKey(did)).toThrow('Invalid secp256k1 public key length')
  })

  test('keeps fixed canonical base64url values and both alphabet replacements', () => {
    expect(base64UrlEncode([0xfb, 0xff, 0xef])).toBe('-__v')
    expect(base64UrlDecode('-__v')).toEqual([0xfb, 0xff, 0xef])
    expect(base64UrlDecode('Zg')).toEqual([102])
    expect(base64UrlDecode('Zm8')).toEqual([102, 111])
    expect(base64UrlDecode('Zm9v')).toEqual([102, 111, 111])
    expect(base64UrlDecode('', 0)).toEqual([])
  })
})

describe('codec fails closed when an SDK validation/serialization boundary fails', () => {
  // These tests intentionally exercise defensive dependency-failure checks, not
  // additional wire encodings. SDK classes remain the actual public-key objects.
  // All fault injections are scoped and restored even when an assertion fails.
  test('rejects an invalid PublicKey instance before asking it to serialize', () => {
    const point = PublicKey.fromString(KEY)
    const validate = jest.spyOn(point, 'validate').mockReturnValue(false)
    const serialize = jest.spyOn(point, 'toDER')
    try {
      expect(() => normalizePublicKey(point)).toThrow('Public key is not a valid secp256k1 point')
      expect(serialize).not.toHaveBeenCalled()
    } finally {
      serialize.mockRestore()
      validate.mockRestore()
    }
  })

  test('rejects a PublicKey serializer returning a truncated compressed point', () => {
    const point = PublicKey.fromString(KEY)
    const serialize = jest.spyOn(point, 'toDER').mockReturnValue(keyBytes().slice(1))
    try {
      expect(() => normalizePublicKey(point)).toThrow('Invalid secp256k1 public key length')
    } finally {
      serialize.mockRestore()
    }
  })

  test('rejects an SDK-parsed point whose independent validation fails', () => {
    const validate = jest.spyOn(PublicKey.prototype, 'validate').mockReturnValue(false)
    try {
      expect(() => publicKeyToDidKey(keyBytes())).toThrow(
        'Public key is not a valid secp256k1 point'
      )
    } finally {
      validate.mockRestore()
    }
  })

  test.each(['shorter', 'different byte'] as const)(
    'rejects SDK compressed re-encoding that is %s instead of the validated input',
    fault => {
      const canonical = keyBytes()
      const replacement = fault === 'shorter' ? canonical.slice(0, -1) : [...canonical]
      if (fault === 'different byte') replacement[32] ^= 1
      const serialize = jest.spyOn(PublicKey.prototype, 'toDER').mockReturnValue(replacement)
      try {
        expect(() => publicKeyToDidKey(canonical)).toThrow('Noncanonical compressed identity key')
      } finally {
        serialize.mockRestore()
      }
    }
  )

  test('rejects an inconsistent SDK Base58 re-encoding of a previously decoded DID', () => {
    // SDK toBase58 ends in String.fromCodePoint. Intercept only this exact fixed
    // Base58 output, avoiding immutable ESM exports and every unrelated encoding.
    // First output verifies incoming Base58; the second constructs the DID again.
    const original = String.fromCodePoint
    let encodings = 0
    const encode = jest.spyOn(String, 'fromCodePoint').mockImplementation((...points: number[]) => {
      const result = original(...points)
      if (result !== MATERIAL.slice(1)) return result
      encodings++
      return encodings === 2 ? `${result.slice(0, -1)}1` : result
    })
    try {
      expect(() => decodeDidKey(DID)).toThrow('Noncanonical did:key identifier')
      expect(encodings).toBe(2)
    } finally {
      encode.mockRestore()
    }
  })
})
