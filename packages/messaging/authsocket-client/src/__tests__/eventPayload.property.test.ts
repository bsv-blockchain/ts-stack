import fc from 'fast-check'

import {
  decodeAuthSocketEventPayload,
  encodeAuthSocketEventPayload,
  isAuthSocketEventPayload
} from '../AuthSocketClient.js'

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

describe('AuthSocket client event payload properties', () => {
  it('round-trips every JSON event payload', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 256 }),
        fc.jsonValue(),
        (eventName, data) => {
          const canonicalData: unknown = JSON.parse(JSON.stringify(data))
          expect(
            decodeAuthSocketEventPayload(encodeAuthSocketEventPayload(eventName, data))
          ).toEqual({ eventName, data: canonicalData })
        }
      )
    )
  })

  it('is total for arbitrary authenticated message bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 8192 }), bytes => {
        expect(() => decodeAuthSocketEventPayload(bytes)).not.toThrow()
        expect(typeof decodeAuthSocketEventPayload(bytes).eventName).toBe('string')
      })
    )
  })

  it('recognizes exactly object envelopes with a string event name', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 3 }), value => {
        const expected =
          value != null &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).eventName === 'string'
        expect(isAuthSocketEventPayload(value)).toBe(expected)
      })
    )
  })

  it('maps valid JSON with a malformed envelope shape to the unknown event', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        fc.pre(
          value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof (value as Record<string, unknown>).eventName !== 'string'
        )
        const bytes = Buffer.from(JSON.stringify(value), 'utf8')
        expect(decodeAuthSocketEventPayload(bytes)).toEqual({
          eventName: '_unknown',
          data: null
        })
      })
    )
  })
})
