import fc from 'fast-check'
import { actionRecoveryJSON } from '../ActionRecoveryCodec'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('canonical action records own bounded generated maps independent of insertion order', () => {
  fc.assert(fc.property(
    fc.dictionary(fc.string({ maxLength: 20 }), fc.oneof(fc.integer(), fc.string({ maxLength: 80 }), fc.boolean(), fc.array(fc.integer(), { maxLength: 20 })), { maxKeys: 20 }),
    record => {
      const encoded = actionRecoveryJSON(record)
      const copy = JSON.parse(encoded)
      expect(copy).toEqual(record)
      expect(actionRecoveryJSON(Object.fromEntries(Object.entries(record).reverse()))).toBe(encoded)
      expect(actionRecoveryJSON(copy)).toBe(encoded)
      for (const key of Object.keys(record)) record[key] = 'changed'
      expect(actionRecoveryJSON(copy)).toBe(encoded)
    }
  ))
})
