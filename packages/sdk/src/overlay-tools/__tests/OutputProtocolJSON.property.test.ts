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

// TextEncoder is the independent oracle for valid Unicode and exact byte fences.
test('canonical strings retain exact UTF-8 limits across scalar boundaries and escaped controls', () => {
  const scalar = fc.oneof(
    fc.integer({ min: 0, max: 0xd7ff }),
    fc.integer({ min: 0xe000, max: 0x10ffff })
  )
  fc.assert(
    fc.property(fc.array(scalar, { maxLength: 32 }), points => {
      const text = String.fromCodePoint(...points),
        expected = JSON.stringify(text),
        size = new TextEncoder().encode(expected).length
      expect(canonicalOutputJSON(text, { bytes: size })).toBe(expected)
      expect(parseOutputJSON(expected, { bytes: size })).toBe(text)
      expect(() => canonicalOutputJSON(text, { bytes: size - 1 })).toThrow('byte limit')
      expect(() => parseOutputJSON(expected, { bytes: size - 1 })).toThrow('byte limit')
    })
  )
})
test('every lone high and low surrogate is rejected even inside ASCII text', () => {
  for (let code = 0xd800; code <= 0xdfff; code++) {
    const text = 'before' + String.fromCharCode(code) + 'after'
    expect(() => canonicalOutputJSON(text)).toThrow('Unpaired JSON surrogate')
    expect(() => parseOutputJSON(JSON.stringify(text))).toThrow('Unpaired JSON surrogate')
  }
  for (const text of ['\uD800\uDC00', '\uDBFF\uDFFF', 'a\uD83D\uDE00b']) {
    expect(canonicalOutputJSON(text)).toBe(JSON.stringify(text))
    expect(parseOutputJSON(JSON.stringify(text))).toBe(text)
  }
})
