import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  bindLCHCollectorRevenueProfile,
  validateLCHCollectorPreparation
} from '../src/overlayCovenant.js'
import { collectorFixture } from './overlay-acquisition-collector-profile.fixture.js'
import {
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  objectId,
  toHex,
  type LCHValue
} from '../src/index.js'
import {
  decodeUnverifiedLCHOverlayContext,
  encodeLCHOverlayContext,
  type LCHOverlayEvidenceType,
  type UnverifiedLCHOverlayContext
} from '../src/overlayAcquisition.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 1982026,
  ...(replayPath ? { path: replayPath } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})
const json = (input: unknown) => new TextEncoder().encode(canonicalOutputJSON(input))
const types: LCHOverlayEvidenceType[] = [
  'authority',
  'offer',
  'quote',
  'payment-demand',
  'payment-receipt',
  'payment-authorization',
  'transaction-evidence',
  'payment-delivery-ack'
]
const entry = fc.record({
  type: fc.constantFrom(...types),
  nonce: fc.uint8Array({ minLength: 16, maxLength: 16 }),
  signatures: fc.integer({ min: 1, max: 28 })
})

it('preserves byte-exact envelopes across both modes and refuses ambiguous evidence histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('paid-lookup' as const, 'listing-covenant' as const),
      fc.array(entry, { minLength: 1, maxLength: 8 }),
      async (mode, entries) => {
        const ordered = await Promise.all(
          entries.map(async (entry, ordinal) => {
            const object = {
              body: { version: 1, nonce: entry.nonce, ordinal },
              signatures: Array.from({ length: entry.signatures }, () => Uint8Array.of(1))
            }
            return {
              type: entry.type,
              object,
              key: entry.type + '\0' + toHex(await objectId(entry.type, object.body))
            }
          })
        )
        ordered.sort((left, right) => {
          if (left.key === right.key) return 0
          return left.key < right.key ? -1 : 1
        })
        const value: UnverifiedLCHOverlayContext = {
            version: 1,
            license: { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
            evidence: ordered.map(({ type, object }) => ({ type, object })),
            settlement: json({ version: 1 }),
            ...(mode === 'paid-lookup'
              ? { paymentEvidence: json({ version: 1 }) }
              : { purchaseEvidence: json({ version: 1 }) })
          },
          original = encodeDeterministicCbor(value as unknown as LCHValue),
          encoded = await encodeLCHOverlayContext(value, mode)
        expect(encoded).toEqual(original)
        expect(
          await encodeLCHOverlayContext(
            await decodeUnverifiedLCHOverlayContext(encoded, mode),
            mode
          )
        ).toEqual(original)
        const duplicate = decodeDeterministicCbor(
          original
        ) as unknown as UnverifiedLCHOverlayContext
        duplicate.evidence.splice(1, 0, {
          ...duplicate.evidence[0],
          object: {
            body: duplicate.evidence[0].object.body,
            signatures: [Uint8Array.of(2)]
          }
        })
        await expect(encodeLCHOverlayContext(duplicate, mode)).rejects.toThrow('sorted and unique')
        const unknown = decodeDeterministicCbor(original) as Record<string, LCHValue>
        unknown.extra = true
        await expect(
          decodeUnverifiedLCHOverlayContext(encodeDeterministicCbor(unknown), mode)
        ).rejects.toThrow('unknown fields')
        await expect(
          decodeUnverifiedLCHOverlayContext(
            encoded,
            mode === 'paid-lookup' ? 'listing-covenant' : 'paid-lookup'
          )
        ).rejects.toThrow('unknown fields')
        expect(encodeDeterministicCbor(value as unknown as LCHValue)).toEqual(original)
      }
    )
  )
}, 180000)

it('retains exact immutable collector schedules and strict preparation expiry across current CBOR profiles', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 499999999 }),
      fc.integer({ min: 1, max: 10000 }),
      (expiry, weight) => {
        const f = collectorFixture(expiry, weight),
          bytes = encodeDeterministicCbor(f.collector as unknown as LCHValue),
          decoded = decodeDeterministicCbor(bytes),
          bound = bindLCHCollectorRevenueProfile(decoded, f.descriptor)
        expect(encodeDeterministicCbor(decoded)).toEqual(bytes)
        expect(bound.collector.initialRevenue).toEqual(f.descriptor.initialRevenue)
        expect(() =>
          validateLCHCollectorPreparation(bound.descriptor, 'active', String(expiry - 1))
        ).not.toThrow()
        expect(() =>
          validateLCHCollectorPreparation(bound.descriptor, 'active', String(expiry))
        ).toThrow('New preparation')
        bound.collector.initialRevenue.recipients[0].weight = 0
        expect(
          bindLCHCollectorRevenueProfile(decoded, f.descriptor).collector.initialRevenue
            .recipients[0].weight
        ).toBe(weight)
      }
    )
  )
}, 180000)
