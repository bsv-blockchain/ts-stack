import fc from 'fast-check'
import { stringifyBRC100 } from '../BRC100ByteEncoding.js'

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

describe('BRC-100 JSON compatibility properties', () => {
  it('preserves every ordinary JSON value exactly', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(stringifyBRC100(value)).toBe(JSON.stringify(value))
      })
    )
  })

  it('serializes actual typed arrays portably without reinterpreting adjacent JSON', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 128 }),
        fc.jsonValue(),
        (bytes, applicationData) => {
          expect(stringifyBRC100({ bytes, applicationData })).toBe(
            JSON.stringify({ bytes: Array.from(bytes), applicationData })
          )
        }
      )
    )
  })
})
