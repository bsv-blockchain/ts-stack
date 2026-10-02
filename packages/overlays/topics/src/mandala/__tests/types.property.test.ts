import fc from 'fast-check'

import { allowlistIssuerPolicy } from '../../admission/issuerPolicy'
import { decodeEnvelope, encodeEnvelope } from '../types.js'
import type { MandalaEnvelope, SpecificLinkage } from '../types.js'

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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const bytesAsHex = (length: number): fc.Arbitrary<string> =>
  fc.uint8Array({ minLength: length, maxLength: length }).map(toHex)

const nonEmptyHex = fc.uint8Array({ minLength: 1, maxLength: 96 }).map(toHex)

const byteArray = fc.uint8Array({ maxLength: 128 }).map(bytes => Array.from(bytes))

const bytesOf = (value: unknown): number[] =>
  Array.from(new TextEncoder().encode(JSON.stringify(value)))

const linkage = fc
  .record({
    prover: bytesAsHex(33),
    verifier: bytesAsHex(33),
    counterparty: bytesAsHex(33),
    protocolID: fc.tuple(
      fc.integer({ min: 0, max: 2 }),
      fc.string({ minLength: 5, maxLength: 64 })
    ),
    keyID: fc.string({ maxLength: 64 }),
    encryptedLinkage: byteArray,
    encryptedLinkageProof: byteArray,
    proofType: fc.integer({ min: 0, max: 255 })
  })
  .map(value => value as SpecificLinkage)

const index = fc.oneof(fc.integer({ min: 0, max: 65_535 }), fc.constant(Number.MAX_SAFE_INTEGER))

const linkageEntry = fc.record({ index, linkage })
const adminEntry = fc.record({ index, details: nonEmptyHex })

const envelope: fc.Arbitrary<MandalaEnvelope> = fc
  .record({
    inputs: fc.uniqueArray(linkageEntry, { maxLength: 8, selector: entry => entry.index }),
    outputs: fc.uniqueArray(linkageEntry, { maxLength: 8, selector: entry => entry.index }),
    admin: fc.uniqueArray(adminEntry, { maxLength: 8, selector: entry => entry.index }),
    deploySig: fc.option(nonEmptyHex, { nil: undefined })
  })
  .map(({ deploySig, ...lists }) => (deploySig === undefined ? lists : { ...lists, deploySig }))

// Text that is not 1+ pairs of lowercase hex: anything else the wallet could send.
const HEX_PAIRS = /^([0-9a-f]{2})+$/
const nonHexDetails: fc.Arbitrary<unknown> = fc.oneof(
  fc.string().filter(text => !HEX_PAIRS.test(text)),
  nonEmptyHex.filter(hex => /[a-f]/.test(hex)).map(hex => hex.toUpperCase()),
  nonEmptyHex.map(hex => hex.slice(1)),
  fc.constant(''),
  fc.integer(),
  fc.constant(null),
  fc.boolean()
)

describe('overlay topic property tests', () => {
  test('round-trips arbitrary v3 envelopes with deterministic UTF-8 bytes', () => {
    fc.assert(
      fc.property(envelope, value => {
        const encoded = encodeEnvelope(value)

        expect(encoded).toEqual(bytesOf(value))
        // fast-check records are not plain Objects; compare against their JSON form so the
        // strict check still catches a stray `deploySig: undefined` on the decoded side.
        expect(decodeEnvelope(encoded)).toStrictEqual(JSON.parse(JSON.stringify(value)))
      })
    )
  })

  test('rejects duplicate indices in every list without changing valid wire bytes', () => {
    fc.assert(
      fc.property(linkageEntry, adminEntry, (link, admin) => {
        const cases: Array<[string, unknown]> = [
          ['inputs', link],
          ['outputs', link],
          ['admin', admin]
        ]
        for (const [key, entry] of cases) {
          expect(() => decodeEnvelope(bytesOf({ [key]: [entry, entry] }))).toThrow(
            `Mandala payload ${key} must contain unique non-negative integer indices`
          )
        }
      })
    )
  })

  test('rejects admin details that are not lowercase hex', () => {
    fc.assert(
      fc.property(index, nonHexDetails, (i, details) => {
        expect(() => decodeEnvelope(bytesOf({ admin: [{ index: i, details }] }))).toThrow(
          'Mandala payload admin details must be lowercase hex'
        )
      })
    )
  })

  test('admits exactly the arbitrary token IDs present in an allowlist', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ maxLength: 80 }), { maxLength: 40 }),
        fc.array(fc.string({ maxLength: 80 }), { maxLength: 80 }),
        (allowed, queries) => {
          const policy = allowlistIssuerPolicy(allowed)

          for (const query of queries) {
            expect(policy.allowIssuance?.(query)).toBe(allowed.includes(query))
          }
        }
      )
    )
  })
})
