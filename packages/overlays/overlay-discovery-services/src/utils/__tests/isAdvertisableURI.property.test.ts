import fc from 'fast-check'

import { isAdvertisableURI } from '../isAdvertisableURI.js'
import { isValidTopicOrServiceName } from '../isValidTopicOrServiceName.js'

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

const nameSegment = fc.stringMatching(/^[a-z]{1,8}$/)
const serviceName = fc
  .tuple(fc.constantFrom('tm_', 'ls_'), fc.array(nameSegment, { minLength: 1, maxLength: 5 }))
  .map(([prefix, segments]) => `${prefix}${segments.join('_')}`)
const hostname = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}[a-z0-9]$|^[a-z]$/), {
    minLength: 1,
    maxLength: 4
  })
  .map(labels => `${labels.join('.')}.org`)

describe('overlay discovery boundary properties', () => {
  test('accepts arbitrary BRC-87 topic and service names and rejects case ambiguity', () => {
    fc.assert(
      fc.property(serviceName, name => {
        expect(isValidTopicOrServiceName(name)).toBe(true)
        expect(isValidTopicOrServiceName(name.toUpperCase())).toBe(false)
      })
    )
  })

  test('accepts generated public transport advertisements across every HTTPS scheme', () => {
    fc.assert(
      fc.property(
        hostname,
        fc.constantFrom(
          'https://',
          'https+bsvauth://',
          'https+bsvauth+smf://',
          'https+bsvauth+scrypt-offchain://',
          'https+rtt://',
          'wss://'
        ),
        (host, scheme) => {
          expect(isAdvertisableURI(`${scheme}${host}`)).toBe(true)
        }
      )
    )
  })

  test('enforces JS8 geographic ranges and complete positive measurements', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -90, max: 90 }),
        fc.integer({ min: -180, max: 180 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (lat, long, freq, radius) => {
          const prefix = `js8c+bsvauth+smf:?lat=${lat}&long=${long}`
          expect(isAdvertisableURI(`${prefix}&freq=${freq}Hz&radius=${radius}km`)).toBe(true)
          expect(isAdvertisableURI(`${prefix}&freq=-${freq}Hz&radius=${radius}km`)).toBe(false)
          expect(isAdvertisableURI(`${prefix}&freq=${freq}Hz&radius=junk${radius}km`)).toBe(false)
        }
      )
    )
  })

  test('rejects malformed transports and exact geographic boundary violations', () => {
    for (const invalid of [
      'https://%',
      'https+bsvauth://%',
      'wss://%',
      'https://localhost',
      'wss://localhost',
      'https://example.org/path',
      'js8c+bsvauth+smf:?lat=91&long=0&freq=1Hz&radius=1km',
      'js8c+bsvauth+smf:?lat=0&long=181&freq=1Hz&radius=1km',
      'js8c+bsvauth+smf:?lat=0&long=NaN&freq=1Hz&radius=1km'
    ]) {
      expect(isAdvertisableURI(invalid)).toBe(false)
    }
  })

  test('is total for arbitrary untrusted strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), value => {
        expect(() => isAdvertisableURI(value)).not.toThrow()
        expect(() => isValidTopicOrServiceName(value)).not.toThrow()
      })
    )
  })
})
