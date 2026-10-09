import fc from 'fast-check'
import { deepStrictEqual } from 'node:assert/strict'
import {
  canonicalOutputJSON,
  ownOutputJSON,
  parseOutputJSON,
  type OutputJSON
} from '../OutputProtocolJSON.js'

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

test('bounded ownership preserves nested canonical values, descriptors and independent copies over 300 cases', () => {
  const data = fc.letrec<{ value: OutputJSON }>(tie => ({
    value: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
      fc.string({ maxLength: 32 }),
      fc.array(tie('value'), { maxLength: 8 }),
      fc
        .array(
          fc.tuple(
            fc.oneof(
              fc.string({ maxLength: 16 }),
              fc.constantFrom('constructor', 'prototype', '__proto__')
            ),
            tie('value')
          ),
          { maxLength: 8 }
        )
        .map(entries => Object.fromEntries(entries))
    )
  })).value
  function independent(input: OutputJSON, value: OutputJSON): void {
    if (value === null || typeof value !== 'object') return
    expect(value).not.toBe(input)
    if (Array.isArray(value)) {
      expect(Array.isArray(input)).toBe(true)
      expect(Object.getPrototypeOf(value)).toBe(Array.prototype)
      for (let index = 0; index < value.length; index++)
        independent((input as OutputJSON[])[index], value[index])
    } else {
      expect(Object.getPrototypeOf(value)).toBeNull()
      for (const key of Object.keys(value)) {
        expect(Object.getOwnPropertyDescriptor(value, key)).toEqual({
          value: value[key],
          enumerable: true,
          writable: true,
          configurable: true
        })
        independent((input as Record<string, OutputJSON>)[key], value[key])
      }
    }
  }
  fc.assert(
    fc.property(data, input => {
      const before = canonicalOutputJSON(input),
        bytes = new TextEncoder().encode(before).length
      const snapshot = ownOutputJSON(input, { bytes })
      expect(snapshot.text).toBe(before)
      deepStrictEqual(snapshot.value, parseOutputJSON(before, { bytes }))
      independent(input, snapshot.value)
      if (bytes > 1) expect(() => ownOutputJSON(input, { bytes: bytes - 1 })).toThrow('byte limit')
      if (snapshot.value !== null && typeof snapshot.value === 'object') {
        if (Array.isArray(snapshot.value)) snapshot.value.push('owned-only')
        else snapshot.value['owned-only'] = true
      }
      expect(canonicalOutputJSON(input)).toBe(before)
      deepStrictEqual(ownOutputJSON(input).value, parseOutputJSON(before))
    }),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
})

test('explicit scalar inspection matches original complete canonical/refusal behavior for fresh generated maps', async () => {
  const {
    inspectOutputJSONEncoding: original,
    inspectOutputJSONEncodingWithScalarRecords: inspect
  } = await import('../OutputProtocolJSON.js')
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.tuple(
          fc.oneof(
            fc.string({ maxLength: 16 }),
            fc.constantFrom('constructor', 'prototype', '__proto__', 'a,b:c')
          ),
          fc.oneof(fc.integer(), fc.string({ maxLength: 32 }), fc.boolean(), fc.constant(null))
        ),
        { maxLength: 16, selector: entry => entry[0] }
      ),
      entries => {
        const source = canonicalOutputJSON(Object.fromEntries(entries)),
          bytes = new TextEncoder().encode(source)
        for (const input of [source, bytes, ' ' + source + '\n']) {
          const first = inspect(input),
            second = inspect(input),
            expected = original(input)
          deepStrictEqual(first, expected)
          deepStrictEqual(second, expected)
          expect(first.value).not.toBe(second.value)
          expect(Object.getPrototypeOf(first.value)).toBeNull()
          expect(canonicalOutputJSON(first.value)).toBe(source)
        }
        expect(inspect(source, { bytes: bytes.length })).toEqual(
          original(source, { bytes: bytes.length })
        )
        expect(() => inspect(source, { bytes: bytes.length - 1 })).toThrow()
      }
    )
  )
})
