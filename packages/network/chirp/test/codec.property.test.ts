import { describe, expect, test } from '@jest/globals'
import fc from 'fast-check'
import {
  CHIRPBuilder,
  decodeCompactSize,
  encodeCompactSize,
  validateCHIRPClosure
} from '../src/index.js'

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

describe('CHIRP codec properties', () => {
  test('round-trips canonical CompactSize uint64 values', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 0xffff_ffff_ffff_ffffn }), value => {
        const encoded = encodeCompactSize(value)
        const decoded = decodeCompactSize(encoded, 0)
        expect(decoded).toEqual({ value, offset: encoded.byteLength })
      })
    )
  })

  test('builds deterministic, fully valid closures for arbitrary bounded bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 32_768 }), async source => {
        const objects = new Map<string, Uint8Array>()
        const first = await new CHIRPBuilder().build(source, {
          sink: {
            async putObject(identifier, bytes) {
              objects.set(identifier, bytes.slice())
            }
          }
        })
        const second = await new CHIRPBuilder().build(source)
        expect(second.rootIdentifier).toBe(first.rootIdentifier)
        const validated = await validateCHIRPClosure(first.rootIdentifier, async identifier => {
          const bytes = objects.get(identifier)
          if (bytes == null) throw new Error(`missing ${identifier}`)
          return bytes
        })
        expect(validated.logicalLength).toBe(BigInt(source.byteLength))
        expect(validated.profileCanonical).toBe(true)
      })
    )
  })
})
