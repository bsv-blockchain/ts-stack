import fc from 'fast-check'
import { Utils } from '@bsv/sdk'

import { convertValueToArray, writeHeaderPair } from '../authMiddlewareHelpers.js'

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

function readString(reader: Utils.Reader): string {
  return Utils.toUTF8(reader.read(reader.readVarIntNum()))
}

describe('auth transport serialization properties', () => {
  test('round-trips arbitrary Unicode header keys and values without field ambiguity', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), fc.string({ maxLength: 2048 }), (key, value) => {
        const writer = new Utils.Writer()
        writeHeaderPair(writer, key, value)
        const reader = new Utils.Reader(writer.toArray())

        expect(readString(reader)).toBe(key)
        expect(readString(reader)).toBe(value)
        expect(reader.pos).toBe(reader.bin.length)
      })
    )
  })

  test('preserves arbitrary typed-array slices without adjacent backing-buffer bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4096 }),
        fc.uint8Array({ maxLength: 32 }),
        fc.uint8Array({ maxLength: 32 }),
        (value, prefix, suffix) => {
          const backing = new Uint8Array(prefix.length + value.length + suffix.length)
          backing.set(prefix)
          backing.set(value, prefix.length)
          backing.set(suffix, prefix.length + value.length)
          const view = new Uint8Array(backing.buffer, prefix.length, value.length)

          expect(convertValueToArray(view, {})).toEqual(Array.from(value))
        }
      )
    )
  })

  test('serializes arbitrary JSON response values deterministically and assigns JSON content type', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const headers: Record<string, string> = {}
        const first = convertValueToArray(value, headers)
        const second = convertValueToArray(value, {})

        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          expect(headers['content-type']).toBe('application/json')
        }
        expect(first).toEqual(second)
      })
    )
  })
})
