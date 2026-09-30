import fc from 'fast-check'
import { canonicalOutputJSON, parseOutputJSON } from '../OutputProtocolJSON.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('canonical map round trips preserve every own data field and exact UTF-8 bounds', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.tuple(
          fc.oneof(
            fc.string({ maxLength: 16 }),
            fc.constantFrom('constructor', 'prototype', '__proto__')
          ),
          fc.oneof(fc.integer(), fc.string({ maxLength: 32 }), fc.boolean(), fc.constant(null))
        ),
        { maxLength: 16, selector: entry => entry[0] }
      ),
      entries => {
        const input = Object.fromEntries(entries)
        const canonical = canonicalOutputJSON(input)
        const size = new TextEncoder().encode(canonical).length
        const parsed = parseOutputJSON(canonical, { bytes: size }) as Record<string, unknown>
        expect(Object.getPrototypeOf(parsed)).toBeNull()
        expect(canonicalOutputJSON(parsed, { bytes: size })).toBe(canonical)
        expect(new Map(Object.entries(parsed))).toEqual(new Map(entries))
        for (const [key, value] of entries) {
          expect(Object.getOwnPropertyDescriptor(parsed, key)).toEqual({
            value,
            enumerable: true,
            writable: true,
            configurable: true
          })
          parsed[key] = 'owned change'
          expect(parsed[key]).toBe('owned change')
          delete parsed[key]
          expect(Object.hasOwn(parsed, key)).toBe(false)
        }
        expect(() => parseOutputJSON(canonical, { bytes: size - 1 })).toThrow('byte limit')
        expect(() => canonicalOutputJSON(input, { bytes: size - 1 })).toThrow('byte limit')
      }
    )
  )
})
