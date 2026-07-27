import fc from 'fast-check'

import { fromBase58, fromBase58Check, toBase58, toBase58Check } from '../../primitives/utils'

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

describe('base58 property tests', () => {
  const nonEmptyBytes = fc.uint8Array({ minLength: 1, maxLength: 96 })
  const prefixBytes = fc.uint8Array({ minLength: 1, maxLength: 4 })
  const payloadBytes = fc.uint8Array({ maxLength: 96 })

  test('round-trips arbitrary non-empty byte sequences', () => {
    fc.assert(
      fc.property(nonEmptyBytes, input => {
        const bytes = Array.from(input)
        expect(fromBase58(toBase58(bytes))).toEqual(bytes)
      })
    )
  })

  test('round-trips arbitrary Base58Check payloads and rejects checksum mutation', () => {
    fc.assert(
      fc.property(prefixBytes, payloadBytes, (prefixInput, payloadInput) => {
        const prefix = Array.from(prefixInput)
        const data = Array.from(payloadInput)
        const encoded = toBase58Check(data, prefix)

        expect(fromBase58Check(encoded, undefined, prefix.length)).toEqual({
          prefix,
          data
        })

        const tampered = fromBase58(encoded)
        tampered[tampered.length - 1] ^= 1
        expect(() => fromBase58Check(toBase58(tampered), undefined, prefix.length)).toThrow(
          'Invalid checksum'
        )
      })
    )
  })

  test('matches independent vectors and enforces malformed-input and hex-output boundaries', () => {
    expect(fromBase58('111z')).toEqual([0, 0, 0, 57])
    expect(toBase58([0, 0, 0, 57])).toBe('111z')
    const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    const invalidAscii = Array.from({ length: 128 }, (_, codePoint) =>
      String.fromCodePoint(codePoint)
    ).filter(character => !base58Alphabet.includes(character))
    for (const invalid of ['', ...invalidAscii, 'é', '🚀']) {
      expect(() => fromBase58(invalid)).toThrow()
    }

    const encoded = toBase58Check([1, 2])
    expect(fromBase58Check(encoded, 'hex')).toEqual({
      prefix: '00',
      data: '0102'
    })
  })
})
