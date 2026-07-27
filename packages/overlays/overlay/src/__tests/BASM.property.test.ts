import fc from 'fast-check'

import { computeBasmRoot, computeTac } from '../BASM.js'
import { serializeErrorForLog, serializeLogValue } from '../SafeLog.js'

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

const hashHex = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString('hex'))

describe('overlay integrity and logging properties', () => {
  test('computes the same BASM root from ordered txids and arbitrarily permuted block-index records', () => {
    fc.assert(
      fc.property(fc.uniqueArray(hashHex, { maxLength: 40 }), fc.nat(), (txids, seed) => {
        const records = txids.map((txid, blockIndex) => ({ txid, blockIndex }))
        const shuffled = fc.sample(fc.shuffledSubarray(records, { minLength: records.length }), {
          seed,
          numRuns: 1
        })[0]

        expect(computeBasmRoot(shuffled)).toBe(computeBasmRoot(txids))
        expect(computeBasmRoot(txids.map(txid => txid.toUpperCase()))).toBe(computeBasmRoot(txids))
      })
    )
  })

  test('produces deterministic 32-byte TAC values and rejects every malformed hash input', () => {
    fc.assert(
      fc.property(hashHex, hashHex, hashHex, (previous, block, root) => {
        const tac = computeTac(previous, block, root)
        expect(tac).toMatch(/^[0-9a-f]{64}$/)
        expect(computeTac(previous, block, root)).toBe(tac)
      })
    )

    fc.assert(
      fc.property(
        fc.string().filter(value => !/^[0-9a-fA-F]{64}$/.test(value)),
        invalid => {
          expect(() => computeTac(invalid, '00'.repeat(32), '00'.repeat(32))).toThrow('32 bytes')
        }
      )
    )
  })

  test('serializes arbitrary JSON as one forge-resistant log field', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const serialized = serializeLogValue(value)
        const canonical = JSON.parse(JSON.stringify(value))
        expect(serialized).not.toMatch(/[\r\n\u0080-\u009f\u2028\u2029]/)
        expect(JSON.parse(serialized)).toEqual(canonical)
        expect(serializeErrorForLog(value)).toBe(serialized)
      })
    )
  })
})
