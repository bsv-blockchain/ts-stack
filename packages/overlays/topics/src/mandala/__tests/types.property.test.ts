import fc from 'fast-check'

import { allowlistIssuerPolicy } from '../../admission/issuerPolicy'
import {
  decodeLinkagePayload,
  encodeLinkagePayload,
  type MandalaLinkagePayload,
  type SpecificLinkage
} from '../types.js'

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

const bytesAsHex = (length: number): fc.Arbitrary<string> =>
  fc
    .uint8Array({ minLength: length, maxLength: length })
    .map(bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''))

const byteArray = fc.uint8Array({ maxLength: 128 }).map(bytes => Array.from(bytes))

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

const linkageEntry = fc.record({
  index: fc.integer({ min: 0, max: 65_535 }),
  linkage
})

const linkagePayload = fc
  .record({
    inputs: fc.array(linkageEntry, { maxLength: 8 }),
    outputs: fc.array(linkageEntry, { maxLength: 8 })
  })
  .map(value => value as MandalaLinkagePayload)

describe('overlay topic property tests', () => {
  test('round-trips arbitrary linkage payloads with deterministic UTF-8 bytes', () => {
    fc.assert(
      fc.property(linkagePayload, payload => {
        const encoded = encodeLinkagePayload(payload)

        expect(encoded).toEqual(Array.from(new TextEncoder().encode(JSON.stringify(payload))))
        expect(decodeLinkagePayload(encoded)).toEqual(payload)
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
