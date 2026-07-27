import fc from 'fast-check'

import {
  isBaseBlockHeader,
  isBlockHeader,
  isLive,
  isLiveBlockHeader
} from '../BlockHeaderApi'

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

describe('block-header guard properties', () => {
  it('is total and exactly classifies arbitrary provider responses', () => {
    const completeHeaderShape = fc.record({
      previousHash: fc.string(),
      height: fc.jsonValue(),
      chainWork: fc.jsonValue(),
      headerId: fc.jsonValue()
    })
    fc.assert(
      fc.property(fc.oneof(fc.anything({ maxDepth: 5 }), completeHeaderShape), value => {
        const isRecord = value !== null && typeof value === 'object'
        const record = value as Record<string, unknown>
        const hasPreviousHash = isRecord && typeof record.previousHash === 'string'

        expect(isBaseBlockHeader(value)).toBe(hasPreviousHash)
        expect(isBlockHeader(value)).toBe(isRecord && 'height' in record && hasPreviousHash)
        expect(isLive(value)).toBe(isRecord && record.headerId !== undefined)
        expect(isLiveBlockHeader(value)).toBe(
          isRecord && 'chainWork' in record && hasPreviousHash
        )
      })
    )
  })

  it('requires the declared discriminator fields', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 32 }), fc.jsonValue()),
        record => {
          if (isBaseBlockHeader(record)) expect(typeof record.previousHash).toBe('string')
          if (isBlockHeader(record)) {
            expect('height' in record).toBe(true)
            expect(typeof record.previousHash).toBe('string')
          }
          if (isLive(record)) expect(record.headerId).not.toBeUndefined()
          if (isLiveBlockHeader(record)) {
            expect('chainWork' in record).toBe(true)
            expect(typeof record.previousHash).toBe('string')
          }
        }
      )
    )
  })
})
