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

test('inlined string serialization matches the original nested canonical and exact resource contract over 300 cases', async () => {
  const { canonicalOutputJSONWithInlineStrings: encode } = await import('../OutputProtocolJSON.js')
  const data = fc.letrec<{ value: OutputJSON }>(tie => ({
    value: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.string({ maxLength: 32 }),
      fc.array(tie('value'), { maxLength: 8 }),
      fc
        .array(fc.tuple(fc.string({ maxLength: 16 }), tie('value')), { maxLength: 8 })
        .map(entries => Object.fromEntries(entries))
    )
  })).value
  fc.assert(
    fc.property(data, input => {
      const expected = canonicalOutputJSON(input),
        bytes = new TextEncoder().encode(expected).length
      expect(encode(input)).toBe(expected)
      expect(encode(input, { bytes })).toBe(expected)
      expect(encode(input)).toBe(expected)
      if (bytes > 1) expect(() => encode(input, { bytes: bytes - 1 })).toThrow('byte limit')
      expect(canonicalOutputJSON(input)).toBe(expected)
    })
  )
})

test('explicit native ownership preserves generated nested bytes, limits and independent graphs', () => {
  const { ownOutputJSONWithInlineStrings } =
    require('../OutputProtocolJSON.js') as typeof import('../OutputProtocolJSON.js')
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.tuple(
          fc.string({ maxLength: 12 }),
          fc.oneof(fc.string({ maxLength: 24 }), fc.integer(), fc.boolean(), fc.constant(null))
        ),
        { maxLength: 10, selector: entry => entry[0] }
      ),
      entries => {
        const record = Object.fromEntries(entries),
          input = { payload: record, history: [record], version: 1 },
          expected = ownOutputJSON(input),
          size = new TextEncoder().encode(expected.text).length,
          actual = ownOutputJSONWithInlineStrings(input, { bytes: size })
        deepStrictEqual(actual, expected)
        const graph = actual.value as Record<string, OutputJSON>,
          payload = graph.payload as Record<string, OutputJSON>,
          history = graph.history as Array<Record<string, OutputJSON>>
        expect(Object.getPrototypeOf(payload)).toBeNull()
        expect(Object.getPrototypeOf(history[0])).toBeNull()
        expect(payload).not.toBe(record)
        expect(payload).not.toBe(history[0])
        payload['new-owned-field'] = true
        expect(Object.hasOwn(record, 'new-owned-field')).toBe(false)
        expect(Object.hasOwn(history[0], 'new-owned-field')).toBe(false)
        expect(() => ownOutputJSONWithInlineStrings(input, { bytes: size - 1 })).toThrow()
      }
    )
  )
})

test('fresh recursive ownership matches ordinary bytes, attributes and exact fences over 300 cases', () => {
  const { ownOutputJSONWithInlineStrings } =
    require('../OutputProtocolJSON.js') as typeof import('../OutputProtocolJSON.js')
  const data = fc.letrec<{ value: OutputJSON }>(tie => ({
    value: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.constant(-0),
      fc.oneof(fc.string({ maxLength: 24 }), fc.constantFrom('𝄞', 'é', '\n"\\', 'a,b:c')),
      fc.array(tie('value'), { maxLength: 6 }),
      fc
        .array(
          fc.tuple(
            fc.oneof(
              fc.string({ maxLength: 12 }),
              fc.constantFrom('__proto__', 'constructor', 'prototype')
            ),
            tie('value')
          ),
          { maxLength: 6 }
        )
        .map(entries => Object.fromEntries(entries))
    )
  })).value
  const inspect = (input: OutputJSON, owned: OutputJSON): void => {
    if (input === null || typeof input !== 'object') {
      expect(owned).toBe(typeof input === 'number' && input === 0 ? 0 : input)
      return
    }
    expect(owned).not.toBe(input)
    expect(Object.getPrototypeOf(owned)).toBe(Array.isArray(input) ? Array.prototype : null)
    for (const key of Object.keys(input)) {
      const expected = Object.getOwnPropertyDescriptor(input, key)!,
        actual = Object.getOwnPropertyDescriptor(owned, key)!
      expect(actual).toMatchObject({ enumerable: true, writable: true, configurable: true })
      expect(Object.hasOwn(actual, 'get')).toBe(false)
      inspect(expected.value as OutputJSON, actual.value as OutputJSON)
    }
  }
  fc.assert(
    fc.property(data, input => {
      const expected = ownOutputJSON(input),
        bytes = new TextEncoder().encode(expected.text).length,
        actual = ownOutputJSONWithInlineStrings(input, { bytes }),
        repeated = ownOutputJSONWithInlineStrings(input, { bytes })
      deepStrictEqual(actual, expected)
      deepStrictEqual(repeated, expected)
      inspect(input, actual.value)
      expect(canonicalOutputJSON(actual.value, { bytes })).toBe(expected.text)
      if (input !== null && typeof input === 'object') expect(repeated.value).not.toBe(actual.value)
      if (bytes > 1)
        expect(() => ownOutputJSONWithInlineStrings(input, { bytes: bytes - 1 })).toThrow(
          'byte limit'
        )
      expect(ownOutputJSONWithInlineStrings(input)).toEqual(expected)
    })
  )
})

test('owned-record parser and recursive inline codec retain original contracts over 300 nested cases', () => {
  const {
    parseOutputJSONWithOwnedRecords,
    inspectOutputJSONEncodingWithOwnedRecords,
    inspectOutputJSONEncoding,
    canonicalOutputJSONWithInlineRecords,
    ownOutputJSONWithInlineRecords
  } = require('../OutputProtocolJSON.js') as typeof import('../OutputProtocolJSON.js')
  const data = fc.letrec<{ value: OutputJSON }>(tie => ({
    value: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.constant(-0),
      fc.oneof(fc.string({ maxLength: 24 }), fc.constantFrom('𝄞', 'é', '\n"\\', 'a,b:c')),
      fc.array(tie('value'), { maxLength: 6 }),
      fc
        .array(
          fc.tuple(
            fc.oneof(
              fc.string({ maxLength: 12 }),
              fc.constantFrom('__proto__', 'constructor', 'prototype')
            ),
            tie('value')
          ),
          { maxLength: 6 }
        )
        .map(entries => Object.fromEntries(entries))
    )
  })).value
  fc.assert(
    fc.property(data, input => {
      const expected = ownOutputJSON(input),
        size = new TextEncoder().encode(expected.text).length,
        encoded = JSON.stringify(input),
        wireSize = new TextEncoder().encode(encoded).length,
        actual = ownOutputJSONWithInlineRecords(input, { bytes: size })
      deepStrictEqual(actual, expected)
      expect(canonicalOutputJSONWithInlineRecords(input, { bytes: size })).toBe(expected.text)
      for (const source of [encoded, new TextEncoder().encode(encoded)]) {
        deepStrictEqual(
          parseOutputJSONWithOwnedRecords(source, { bytes: wireSize }),
          parseOutputJSON(source, { bytes: wireSize })
        )
        deepStrictEqual(
          inspectOutputJSONEncodingWithOwnedRecords(source),
          inspectOutputJSONEncoding(source)
        )
      }
      deepStrictEqual(parseOutputJSONWithOwnedRecords(expected.text), expected.value)
      if (input !== null && typeof input === 'object') expect(actual.value).not.toBe(input)
      if (size > 1) {
        expect(() => canonicalOutputJSONWithInlineRecords(input, { bytes: size - 1 })).toThrow(
          'byte limit'
        )
        expect(() => ownOutputJSONWithInlineRecords(input, { bytes: size - 1 })).toThrow(
          'byte limit'
        )
      }
    })
  )
})

import {
  canonicalOutputJSONWithDirectRecords,
  canonicalOutputJSONWithInlineRecords
} from '../OutputProtocolJSON.js'

test('direct record emission preserves generated nested JCS values and exact byte fences over 300 cases', () => {
  const scalar = fc.oneof(
    fc.integer({ min: 0, max: 0xd7ff }),
    fc.integer({ min: 0xe000, max: 0x10ffff })
  )
  const text = fc.array(scalar, { maxLength: 16 }).map(points => String.fromCodePoint(...points))
  const data = fc.letrec<{ value: OutputJSON }>(tie => ({
    value: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
      text,
      fc.array(tie('value'), { maxLength: 8 }),
      fc
        .array(
          fc.tuple(
            fc.oneof(text, fc.constantFrom('0', '10', '2', '__proto__', 'constructor')),
            tie('value')
          ),
          { maxLength: 8 }
        )
        .map(entries => Object.fromEntries(entries))
    )
  })).value
  fc.assert(
    fc.property(data, input => {
      const original = canonicalOutputJSON(input),
        size = new TextEncoder().encode(original).length
      expect(canonicalOutputJSONWithDirectRecords(input)).toBe(original)
      expect(canonicalOutputJSONWithDirectRecords(input, { bytes: size })).toBe(original)
      expect(canonicalOutputJSONWithDirectRecords(input)).toBe(
        canonicalOutputJSONWithInlineRecords(input)
      )
      expect(() => canonicalOutputJSONWithDirectRecords(input, { bytes: size - 1 })).toThrow()
    })
  )
})
