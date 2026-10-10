import { closedOutputObject, createClosedOutputObjectValidator } from '../OutputProtocol.js'
import { runInNewContext } from 'node:vm'
import { isDeepStrictEqual } from 'node:util'
import * as s from '../OutputProtocolSchema.js'
import { canonicalOutputJSON, ownOutputJSON, parseOutputJSON } from '../OutputProtocolJSON.js'
const hex = '11'.repeat(32)
const chain = { network: 'test', genesisHash: hex }
const invalid = expect.objectContaining({ code: 'invalid' })
function owned(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype)
    for (const child of value) owned(child)
  } else {
    expect(Object.getPrototypeOf(value)).toBeNull()
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      expect(descriptor).toEqual({
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true
      })
      owned(descriptor.value)
    }
  }
}
test('captures independent nested data, own builtin-like keys and unchanged canonical bytes', () => {
  const input = {
    rows: [{ ['__proto__']: { constructor: ['é😀', null, -0, true] }, prototype: 'data' }]
  }
  const first = ownOutputJSON(input),
    second = ownOutputJSON(input)
  expect(first.text).toBe(canonicalOutputJSON(input))
  expect(isDeepStrictEqual(first.value, parseOutputJSON(first.text))).toBe(true)
  owned(first.value)
  owned(second.value)
  const copy = first.value as { rows: { __proto__: { constructor: unknown[] } }[] }
  copy.rows[0].__proto__.constructor.push('changed')
  expect(input.rows[0].__proto__.constructor).toHaveLength(4)
  expect(isDeepStrictEqual(second.value, parseOutputJSON(second.text))).toBe(true)
  expect(Object.is(copy.rows[0].__proto__.constructor[2], -0)).toBe(false)
})
test.each([null, true, false, 0, 'é😀', [], {}])('captures all JSON value kinds: %p', input => {
  const result = ownOutputJSON(input)
  expect(result.value).toStrictEqual(parseOutputJSON(result.text))
  owned(result.value)
})
test('separates repeated caller references into independently owned JSON subtrees', () => {
  const shared = { values: [1, 2] }
  const result = ownOutputJSON({ left: shared, right: shared })
  const value = result.value as { left: { values: number[] }; right: { values: number[] } }
  expect(value.left).not.toBe(value.right)
  expect(value.left.values).not.toBe(value.right.values)
  value.left.values.push(3)
  expect(value.right.values).toEqual([1, 2])
  expect(shared.values).toEqual([1, 2])
})
test('retains refusal identities and never invokes input getters or changes input prototypes', () => {
  let reads = 0
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      reads++
      return 1
    }
  })
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  for (const input of [
    undefined,
    getter,
    cyclic,
    NaN,
    Infinity,
    0.5,
    '\uD800',
    Object.assign([], { 2: 1 }),
    { value: undefined },
    { value: Symbol('data') },
    new Date(0)
  ]) {
    const refusal = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error as Error & { code: string }
      }
      throw new Error('Unexpected acceptance')
    }
    const before = refusal(() => parseOutputJSON(canonicalOutputJSON(input)))
    expect(refusal(() => ownOutputJSON(input))).toMatchObject({
      name: before.name,
      message: before.message,
      code: before.code
    })
  }
  expect(reads).toBe(0)
  const input = { nested: { value: 1 } }
  ownOutputJSON(input)
  expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(input.nested)).toBe(Object.prototype)
})
test('retains exact byte, depth, element, map and custom-limit fences with one limit read', () => {
  const input = { data: ['é😀'] },
    bytes = new TextEncoder().encode(canonicalOutputJSON(input)).length
  expect(ownOutputJSON(input, { bytes }).text).toBe(canonicalOutputJSON(input))
  expect(() => ownOutputJSON(input, { bytes: bytes - 1 })).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
  )
  expect(() => ownOutputJSON(input, { depth: 2 })).toThrow('JSON depth limit')
  expect(() => ownOutputJSON([1, 2], { arrayElements: 1 })).toThrow('JSON array limit')
  expect(() => ownOutputJSON({ a: 1, b: 2 }, { mapKeys: 1 })).toThrow('JSON map limit')
  for (const bounds of [{ bytes: 0 }, { depth: 33 }, { arrayElements: 4097 }, { mapKeys: 257 }])
    expect(() => ownOutputJSON(input, bounds)).toThrow('Invalid output JSON resource limit')
  let reads = 0
  expect(
    ownOutputJSON(input, {
      get bytes() {
        reads++
        return bytes
      }
    }).text
  ).toBe(canonicalOutputJSON(input))
  expect(reads).toBe(1)
  expect(ownOutputJSON).toHaveLength(1)
})
test('keeps raw text/byte duplicate evidence and applies schemas only after complete normalization', () => {
  const source = '{"value":1,"value":2}'
  expect(ownOutputJSON(source).value).toBe(source)
  for (const input of [source, new TextEncoder().encode(source)])
    expect(() => s.normalized(input, s.json)).toThrow('Duplicate decoded JSON key')
  let called = false
  expect(() =>
    s.normalized(
      { value: 1 },
      value => {
        called = true
        return value
      },
      1
    )
  ).toThrow('byte limit')
  expect(called).toBe(false)
  const definition = s.object({ value: s.text }, { metadata: s.jsonMap })
  const input = { value: 'hello', metadata: { rows: [{ value: true }] } }
  const encoded = canonicalOutputJSON(input)
  for (const source of [input, encoded, new TextEncoder().encode(encoded)]) {
    const result = s.normalized(source, definition)
    expect(result).toEqual(input)
    owned(result)
    expect(result.metadata).not.toBe(input.metadata)
  }
  expect(definition({ value: 'hello' })).toEqual({ value: 'hello' })
  expect(Object.hasOwn(definition({ value: 'hello' }), 'metadata')).toBe(false)
  for (const value of [{ metadata: {} }, { value: 1 }, { value: 'hello', extra: true }])
    expect(() => definition(value)).toThrow(invalid)
})
test('enforces complete array, literal, nullable and own-tagged alternative contracts', () => {
  expect(s.array(s.text)([])).toEqual([])
  expect(s.array(s.text, 2, 1)(['a', 'b'])).toEqual(['a', 'b'])
  for (const value of [[], ['a', 'b', 'c'], [1], 'a', null])
    expect(() => s.array(s.text, 2, 1)(value)).toThrow(invalid)
  for (const value of ['tag', 0, true, null])
    expect(s.literal('tag', 0, true, null)(value)).toBe(value)
  expect(() => s.literal('tag')('other')).toThrow(invalid)
  expect(s.nullable(s.text)(null)).toBeNull()
  expect(s.nullable(s.text)('data')).toBe('data')
  expect(() => s.nullable(s.text)(1)).toThrow(invalid)
  const tagged = s.tagged('kind', {
    a: s.object({ kind: s.literal('a'), value: s.text }),
    b: s.object({ kind: s.literal('b'), value: s.u32 })
  })
  expect(tagged({ kind: 'a', value: 'data' })).toEqual({ kind: 'a', value: 'data' })
  expect(tagged({ kind: 'b', value: 2 })).toEqual({ kind: 'b', value: 2 })
  for (const value of [
    null,
    [],
    { kind: 'constructor' },
    { kind: 1 },
    { kind: 'missing' },
    { kind: 'a', value: 1 },
    { kind: 'b', value: 2, extra: true }
  ])
    expect(() => tagged(value)).toThrow(invalid)
})
test('checks every portable scalar and nested chain/scope/evidence/policy field', () => {
  expect(s.bool(true)).toBe(true)
  expect(s.bool(false)).toBe(false)
  expect(() => s.bool(1)).toThrow(invalid)
  expect(s.u32(4294967295)).toBe(4294967295)
  expect(() => s.u32(4294967296)).toThrow(invalid)
  expect(s.u64('18446744073709551615')).toBe('18446744073709551615')
  for (const value of ['01', '18446744073709551616', -1])
    expect(() => s.u64(value)).toThrow(invalid)
  expect(s.hex(hex)).toBe(hex)
  expect(() => s.hex('AA'.repeat(32))).toThrow(invalid)
  const identity = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  expect(s.identity(identity)).toBe(identity)
  expect(() => s.identity('00')).toThrow(invalid)
  expect(s.bytes('AQ==')).toBe('AQ==')
  expect(() => s.bytes('!')).toThrow(invalid)
  expect(s.chain(chain)).toEqual(chain)
  expect(s.outpoint({ chain, txid: hex, outputIndex: 0 })).toEqual({
    chain,
    txid: hex,
    outputIndex: 0
  })
  const scope = {
    chain,
    provider: 'provider',
    service: 'service',
    queryDigest: hex,
    rulesDigest: hex,
    access: 'public',
    epoch: '1'
  }
  expect(s.scope(scope)).toEqual(scope)
  expect(s.evidence({ txid: hex, outputIndex: 0, beef: 'AQ==' })).toEqual({
    txid: hex,
    outputIndex: 0,
    beef: 'AQ=='
  })
  expect(s.policy({ id: 'urn:test:policy', digest: hex })).toEqual({
    id: 'urn:test:policy',
    digest: hex
  })
  for (const value of [null, [], 1]) expect(() => s.jsonMap(value)).toThrow(invalid)
  const extensions = s.object({ value: s.json }, s.extensions)
  expect(
    extensions({ value: null, extensions: { data: true }, critical: ['urn:test:required'] })
  ).toEqual({ value: null, extensions: { data: true }, critical: ['urn:test:required'] })
  expect(() =>
    extensions({ value: null, critical: Array.from({ length: 33 }, () => 'urn:test:required') })
  ).toThrow(invalid)
})
test.each(['urn:test:x', 'https://example.invalid/path', 'a1+.-:data'])(
  'accepts absolute IRI %s',
  value => expect(s.iri(value)).toBe(value)
)
test.each(['relative/path', '1scheme:value', ':value', ''])('rejects invalid IRI %s', value =>
  expect(() => s.iri(value)).toThrow(invalid)
)
test.each(['A'.repeat(16), '_-09AZaz'.repeat(16)])('accepts request identifier %s', value =>
  expect(s.requestId(value)).toBe(value)
)
test.each(['A'.repeat(15), 'A'.repeat(129), 'A'.repeat(15) + '!', 0, null])(
  'rejects request identifier %p',
  value => expect(() => s.requestId(value)).toThrow(invalid)
)
test('matches independent UTF-8 ordering and requires strictly increasing unique adjacent values', () => {
  const values = ['', 'a', 'aa', 'ab', 'é', 'è', '\uE000', '😀']
  for (const a of values)
    for (const b of values)
      expect(Math.sign(s.compareUTF8(a, b))).toBe(
        Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)))
      )
  expect(s.compareUTF8('😀', '\uE000')).toBeGreaterThan(0)
  for (const values of [[], [1], [1, 2, 3]])
    expect(() => s.sortedUnique(values, (a, b) => a - b)).not.toThrow()
  for (const values of [
    [1, 1],
    [2, 1],
    [1, 3, 2]
  ])
    expect(() => s.sortedUnique(values, (a, b) => a - b)).toThrow('Expected sorted unique list')
})

test('accepts foreign-realm plain data while returning local independently owned records', () => {
  const input: unknown = runInNewContext('({ value: [{ nested: "foreign" }] })')
  const snapshot = ownOutputJSON(input)
  expect(snapshot.value).toEqual({ value: [{ nested: 'foreign' }] })
  owned(snapshot.value)
  expect(snapshot.value).not.toBe(input)
})

test('fixed object grammar owns callbacks and names while each input is checked afresh', () => {
  let calls = 0
  const required: Record<string, s.Schema<unknown>> = {
    value: value => {
      calls++
      return s.text(value)
    }
  }
  const optional: Record<string, s.Schema<unknown>> = { count: s.u32 }
  const fixed = s.fixedObject(required, optional),
    dynamic = s.object(required, optional)
  required.value = s.u32
  required.extra = s.bool
  optional.count = s.text
  optional.note = s.text
  expect(fixed({ value: 'first', count: 1 })).toEqual({ value: 'first', count: 1 })
  expect(fixed({ value: 'second' })).toEqual({ value: 'second' })
  expect(calls).toBe(2)
  expect(dynamic({ value: 2, extra: true, count: 'three', note: 'four' })).toEqual({
    value: 2,
    extra: true,
    count: 'three',
    note: 'four'
  })
  expect(() => fixed({ value: 'first', extra: true })).toThrow('Unknown extra')
  expect(() => dynamic({ value: 1 })).toThrow('Missing extra')
  const first = fixed({ value: 'first' }),
    second = fixed({ value: 'first' })
  expect(first).not.toBe(second)
  expect(Object.getPrototypeOf(first)).toBeNull()
  expect(() => fixed({ value: 1 })).toThrow('Expected bounded string')
})

test('fixed object grammar retains fresh missing unknown symbol prototype and descriptor refusal', () => {
  const fixed = s.fixedObject({ known: s.u32 }, { ['__proto__']: s.text, constructor: s.text })
  expect(fixed({ known: 1, ['__proto__']: 'data', constructor: 'own' })).toEqual({
    known: 1,
    ['__proto__']: 'data',
    constructor: 'own'
  })
  const hidden = Object.defineProperty({ known: 1 }, 'extra', { value: 2 })
  expect(() => fixed(hidden)).toThrow('Unknown extra')
  expect(() => fixed(Object.defineProperty({}, 'known', { value: 1 }))).toThrow(
    'Accessor or hidden protocol field'
  )
  let reads = 0
  const accessor = Object.defineProperty({}, 'known', {
    enumerable: true,
    get() {
      reads++
      return 1
    }
  })
  expect(() => fixed(accessor)).toThrow('Accessor or hidden protocol field')
  expect(reads).toBe(0)
  expect(() => fixed({ other: true })).toThrow('Missing known')
  expect(() => fixed({ [Symbol('extra')]: 1 })).toThrow('Unexpected symbol key')
  expect(() => fixed(Object.create({ known: 1 }))).toThrow('Expected plain object')
  for (const value of [null, [], 1]) expect(() => fixed(value)).toThrow('Expected object')
})

test('dynamic object snapshots required callbacks before invocation and optional callbacks afterwards', () => {
  const required: Record<string, s.Schema<unknown>> = {},
    optional: Record<string, s.Schema<unknown>> = { later: s.text }
  required.first = value => {
    required.second = s.u32
    optional.later = s.u32
    return s.text(value)
  }
  required.second = s.text
  const dynamic = s.object(required, optional)
  expect(dynamic({ first: 'one', second: 'two', later: 3 })).toEqual({
    first: 'one',
    second: 'two',
    later: 3
  })
  expect(dynamic({ first: 'one', second: 2, later: 3 })).toEqual({
    first: 'one',
    second: 2,
    later: 3
  })
})

test('captured closed-object validator owns lists and checks later descriptor changes', () => {
  const required = ['known'],
    optional = ['extra']
  const check: (value: unknown) => asserts value is Record<string, unknown> =
    createClosedOutputObjectValidator(required, optional)
  required.push('later')
  optional.splice(0, 1, 'other')
  const value = { known: 1, extra: 'allowed' }
  expect(() => check(value)).not.toThrow()
  expect(() => closedOutputObject(value, required, optional)).toThrow('Missing later')
  expect(() => check({ known: 1, other: true })).toThrow('Unknown other')
  Object.defineProperty(value, 'known', { enumerable: false })
  expect(() => check(value)).toThrow('Accessor or hidden protocol field')
  expect(() => check({})).toThrow('Missing known')
})

test('owned capture preserves earlier values when later descriptor callbacks mutate caller data', () => {
  const caller = { z: 1, a: { value: 2 } },
    order: string[] = []
  const source = new Proxy(caller, {
    getOwnPropertyDescriptor(target, key) {
      order.push(String(key))
      if (key === 'z') target.a.value = 9
      return Reflect.getOwnPropertyDescriptor(target, key)
    }
  })
  const result = ownOutputJSON(source)
  expect(order).toEqual(['a', 'z'])
  expect(result.text).toBe('{"a":{"value":2},"z":1}')
  expect(result.value).toStrictEqual(parseOutputJSON(result.text))
  expect(caller.a.value).toBe(9)
  owned(result.value)
})

test('owned arrays create data properties without invoking inherited indexed accessors', () => {
  const input = Array.from({ length: 4096 }, () => 0),
    key = '4095'
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, key)
  let reads = 0,
    writes = 0,
    result: ReturnType<typeof ownOutputJSON> | undefined
  try {
    Object.defineProperty(Array.prototype, key, {
      configurable: true,
      get() {
        reads++
        return 7
      },
      set() {
        writes++
      }
    })
    result = ownOutputJSON(input)
  } finally {
    if (previous) Object.defineProperty(Array.prototype, key, previous)
    else Reflect.deleteProperty(Array.prototype, key)
  }
  expect(reads).toBe(0)
  expect(writes).toBe(0)
  expect(Array.isArray(result!.value)).toBe(true)
  expect(Object.getOwnPropertyDescriptor(result!.value, key)).toEqual({
    value: 0,
    enumerable: true,
    writable: true,
    configurable: true
  })
  expect(result!.value).toStrictEqual(parseOutputJSON(result!.text))
})

test('owned capture refuses framing bounds before visiting later caller fields', () => {
  let reads = 0
  const child = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        reads++
        throw new Error('Getter must not run')
      }
    }),
    order: string[] = []
  const source = new Proxy(
    { z: true, a: child },
    {
      getOwnPropertyDescriptor(target, key) {
        order.push(String(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    }
  )
  expect(() => ownOutputJSON(source, { bytes: 1 })).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
  )
  expect(order).toEqual(['a'])
  expect(reads).toBe(0)
  order.length = 0
  expect(() => ownOutputJSON(source)).toThrow('JSON accessor or hidden key')
  expect(order).toEqual(['a'])
  expect(reads).toBe(0)
})

test('parsed and captured arrays retain native data-property attributes and separate negative-zero semantics', () => {
  const source = '{"__proto__":[{"constructor":-0}],"a":true}'
  const parsed = parseOutputJSON(source) as { __proto__: { constructor: number }[]; a: boolean }
  owned(parsed)
  expect(Object.getOwnPropertyDescriptor(parsed.__proto__, '0')).toEqual({
    value: parsed.__proto__[0],
    enumerable: true,
    writable: true,
    configurable: true
  })
  expect(Object.getOwnPropertyDescriptor(parsed.__proto__, 'length')).toEqual({
    value: 1,
    enumerable: false,
    writable: true,
    configurable: false
  })
  expect(Object.is(parsed.__proto__[0].constructor, -0)).toBe(true)
  const captured = ownOutputJSON(parsed).value as typeof parsed
  expect(Object.is(captured.__proto__[0].constructor, -0)).toBe(false)
  captured.__proto__[0].constructor = 2
  expect(Object.is(parsed.__proto__[0].constructor, -0)).toBe(true)
})
test('canonical property names retain UTF-16 order independently of numeric property enumeration', () => {
  const input = Object.fromEntries([
    ['\uE000', 1],
    ['😀', 2],
    ['2', 3],
    ['10', 4]
  ])
  const text = '{"10":4,"2":3,"😀":2,"\uE000":1}'
  expect(canonicalOutputJSON(input)).toBe(text)
  const first = ownOutputJSON(input),
    second = parseOutputJSON(text)
  expect(first.text).toBe(text)
  expect(first.value).toStrictEqual(second)
  expect(Object.keys(first.value as object)).toEqual(['2', '10', '😀', '\uE000'])
})
test('duplicate and collection limits keep their refusal order before malformed children', () => {
  for (const [text, limits, code, message] of [
    ['{"a":0,"\\u0061":INVALID}', { mapKeys: 1 }, 'invalid', 'Duplicate decoded JSON key'],
    ['{"a":0,"b":INVALID}', { mapKeys: 1 }, 'limited', 'JSON map limit'],
    ['[0,INVALID]', { arrayElements: 1 }, 'limited', 'JSON array limit'],
    ['{"a":[]}', { depth: 1 }, 'limited', 'JSON depth limit']
  ] as const) {
    for (const input of [text, new TextEncoder().encode(text)])
      expect(() => parseOutputJSON(input, limits)).toThrow(
        expect.objectContaining({ code, message })
      )
  }
})

test('native owned containers preserve special data keys and bypass inherited array setters', () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0')
  const source = '{"__proto__":[{"toString":0}],"constructor":true}'
  const input = parseOutputJSON(source)
  let parsed: ReturnType<typeof parseOutputJSON> | undefined
  let captured: ReturnType<typeof ownOutputJSON> | undefined
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set() {
        throw new Error('Inherited array setter reached')
      }
    })
    parsed = parseOutputJSON(source)
    captured = ownOutputJSON(input)
  } finally {
    if (previous) Object.defineProperty(Array.prototype, '0', previous)
    else Reflect.deleteProperty(Array.prototype, '0')
  }
  expect(captured?.value).toStrictEqual(parsed)
  for (const value of [parsed, captured?.value]) {
    owned(value)
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
      value: (value as { __proto__: unknown }).__proto__,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
})

import { inspectOutputJSONEncoding } from '../OutputProtocolJSON.js'

test('full-text UTF-8 accounting keeps exact ASCII, Unicode and disguised-byte-view bounds', () => {
  const encoder = new TextEncoder()
  for (const value of [
    'plain',
    '\u0000',
    '\u007F',
    '\u0080',
    '\uD7FF',
    '\uE000',
    '\uFFFF',
    'é',
    '😀'
  ]) {
    const text = JSON.stringify({ value }),
      bytes = encoder.encode(text)
    for (const input of [text, bytes]) {
      const result = inspectOutputJSONEncoding(input, { bytes: bytes.length })
      expect(result.canonical).toBe(true)
      expect(result.value).toEqual({ value })
      owned(result.value)
      expect(() => inspectOutputJSONEncoding(input, { bytes: bytes.length - 1 })).toThrow(
        expect.objectContaining({ code: 'limited' })
      )
    }
    const disguised = Uint8Array.from(bytes)
    Object.defineProperty(disguised, 'byteLength', { value: 1 })
    expect(() => inspectOutputJSONEncoding(disguised, { bytes: 1 })).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
  }
  for (const value of ['\uD800', '\uDFFF']) {
    expect(() => inspectOutputJSONEncoding(JSON.stringify({ value }))).toThrow(invalid)
  }
})

test('value-only normalization retains canonical byte fences, refusal order and fresh owned data', () => {
  const input = { rows: [{ ['__proto__']: ['é😀', null, -0, true] }] }
  const bytes = new TextEncoder().encode(canonicalOutputJSON(input)).length
  const first = s.normalized(input, s.json, bytes),
    second = s.normalized(input, s.json, bytes)
  owned(first)
  owned(second)
  expect(isDeepStrictEqual(first, ownOutputJSON(input, { bytes }).value)).toBe(true)
  expect(first).not.toBe(second)
  const copy = first as { rows: { __proto__: unknown[] }[] }
  copy.rows[0].__proto__.push('changed')
  expect(input.rows[0].__proto__).toHaveLength(4)
  expect(canonicalOutputJSON(second)).toBe(canonicalOutputJSON(input))
  let called = false
  expect(() =>
    s.normalized(
      input,
      value => {
        called = true
        return value
      },
      bytes - 1
    )
  ).toThrow(expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' }))
  expect(called).toBe(false)
  let reads = 0
  Object.defineProperty(input, 'hidden', {
    enumerable: true,
    get() {
      reads++
      return 1
    }
  })
  expect(() => s.normalized(input, s.json)).toThrow('JSON accessor or hidden key')
  expect(reads).toBe(0)
  expect(() => s.normalized({ text: '\uD800' }, s.json)).toThrow('Unpaired JSON surrogate')
})

describe('Explicit fresh-owned schema normalization', () => {
  it('owns every nested node and applies the supplied schema only after validation', () => {
    const shared = { text: 'é😀' },
      input = { left: shared, right: shared }
    let calls = 0
    const schema = (value: unknown) => {
      calls++
      return value as typeof input
    }
    const result = s.normalizedWithInlineStrings(input, schema)
    expect(calls).toBe(1)
    expect(result).toStrictEqual(s.normalized(input, schema))
    expect(calls).toBe(2)
    expect(result.left).not.toBe(result.right)
    expect(result.left).not.toBe(shared)
    owned(result)
    result.left.text = 'changed'
    expect(result.right.text).toBe('é😀')
    expect(shared.text).toBe('é😀')
    expect(() => s.normalizedWithInlineStrings({ text: '\uD800' }, schema)).toThrow()
    expect(calls).toBe(2)
  })
  it('retains caller byte limits and text/byte duplicate-key refusal', () => {
    const value = { a: 'x' }
    expect(s.normalizedWithInlineStrings(value, s.json, 9)).toStrictEqual(
      s.normalized(value, s.json, 9)
    )
    expect(() => s.normalizedWithInlineStrings(value, s.json, 8)).toThrow()
    for (const encoded of ['{"a":1,"a":2}', new TextEncoder().encode('{"a":1,"a":2}')]) {
      expect(() => s.normalizedWithInlineStrings(encoded, s.json)).toThrow()
    }
    expect(s.normalizedWithInlineStrings('{"a":"x"}', s.json, 9)).toStrictEqual(
      s.normalized(value, s.json, 9)
    )
  })
  it('retains the exact default byte boundary', () => {
    const length = 4194304 - 11
    const result = s.normalizedWithInlineStrings({ text: 'x'.repeat(length) }, s.json) as {
      text: string
    }
    expect(result.text).toHaveLength(length)
    expect(() => s.normalizedWithInlineStrings({ text: 'x'.repeat(length + 1) }, s.json)).toThrow()
  })
})

import {
  parseOutputJSONWithOwnedRecords,
  inspectOutputJSONEncodingWithOwnedRecords,
  canonicalOutputJSONWithInlineRecords,
  ownOutputJSONWithInlineRecords
} from '../OutputProtocolJSON.js'

test('owned-record parsing retains lexical values, complete framing and canonical inspection', () => {
  for (const source of [
    '{"rows":[{"__proto__":{"constructor":["é😀",null,-0,true]}}],"empty":{}}',
    ' { "z" : [1e0, true, false, null], "a" : "\\u0061" } ',
    '[[],{},"comma,:quote\\\"",{"𝄞":"é"}]',
    '-0',
    '0',
    'true',
    'null',
    '"escaped\\nline"'
  ]) {
    const bytes = new TextEncoder().encode(source),
      original = parseOutputJSON(source),
      expectedInspection = inspectOutputJSONEncoding(source)
    for (const input of [source, bytes]) {
      const actual = parseOutputJSONWithOwnedRecords(input, { bytes: bytes.length })
      expect(isDeepStrictEqual(actual, original)).toBe(true)
      owned(actual)
      expect(
        isDeepStrictEqual(inspectOutputJSONEncodingWithOwnedRecords(input), expectedInspection)
      ).toBe(true)
      if (bytes.length > 1)
        expect(() => parseOutputJSONWithOwnedRecords(input, { bytes: bytes.length - 1 })).toThrow(
          'byte limit'
        )
    }
  }
  expect(Object.is(parseOutputJSONWithOwnedRecords('-0'), -0)).toBe(true)
  expect(Object.is(ownOutputJSONWithInlineRecords(-0).value, -0)).toBe(false)
})

test('owned-record parsing refuses decoded duplicates, syntax, Unicode and exact structural fences', () => {
  const errorOf = (operation: () => unknown): { name: string; code: unknown; message: string } => {
    try {
      operation()
    } catch (error) {
      const actual = error as Error & { code?: unknown }
      return { name: actual.name, code: actual.code, message: actual.message }
    }
    throw new Error('Expected refusal')
  }
  for (const source of [
    '{"x":1,"x":2}',
    '[{"x":1,"\\u0078":2}]',
    '{"é":1,"\\u00e9":2}',
    '{"x":}',
    '[1,]',
    '{"x":1,}',
    '[1] trailing',
    '01',
    '1e',
    '9007199254740992',
    '"\\uD800"',
    '["\\uDC00"]',
    '\uFEFF{}',
    '"raw\ncontrol"',
    '{"x":truefalse}'
  ]) {
    const expected = errorOf(() => parseOutputJSON(source))
    expect(errorOf(() => parseOutputJSONWithOwnedRecords(source))).toEqual(expected)
    expect(errorOf(() => inspectOutputJSONEncodingWithOwnedRecords(source))).toEqual(
      errorOf(() => inspectOutputJSONEncoding(source))
    )
  }
  for (const [source, limits] of [
    ['{"a":{"b":1}}', { depth: 2 }],
    ['[1,2]', { arrayElements: 1 }],
    ['{"a":1,"b":2}', { mapKeys: 1 }],
    ['"é"', { bytes: 3 }],
    ['{}', { depth: 0 }]
  ] as const) {
    expect(errorOf(() => parseOutputJSONWithOwnedRecords(source, limits))).toEqual(
      errorOf(() => parseOutputJSON(source, limits))
    )
    expect(errorOf(() => inspectOutputJSONEncodingWithOwnedRecords(source, limits))).toEqual(
      errorOf(() => inspectOutputJSONEncoding(source, limits))
    )
  }
  for (const bytes of [
    Uint8Array.from([0xc0, 0x80]),
    Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
  ]) {
    expect(errorOf(() => parseOutputJSONWithOwnedRecords(bytes))).toEqual(
      errorOf(() => parseOutputJSON(bytes))
    )
    expect(parseOutputJSONWithOwnedRecords('{"valid":[1]}')).toEqual(
      parseOutputJSON('{"valid":[1]}')
    )
  }
})

test('recursive inline records preserve keys, independent graphs and exact byte boundaries', () => {
  const shared = { ['__proto__']: ['plain', 'é😀', '\n"\\', -0, null, true] },
    input = { z: [shared, shared], a: shared, ['𝄞']: { ['é']: 'v' } },
    expected = ownOutputJSON(input),
    bytes = new TextEncoder().encode(expected.text).length,
    first = ownOutputJSONWithInlineRecords(input, { bytes }),
    second = ownOutputJSONWithInlineRecords(input, { bytes })
  expect(canonicalOutputJSONWithInlineRecords(input, { bytes })).toBe(expected.text)
  expect(isDeepStrictEqual(first, expected)).toBe(true)
  owned(first.value)
  const graph = first.value as { z: Array<Record<string, unknown>>; a: Record<string, unknown> }
  expect(graph.z[0]).not.toBe(graph.z[1])
  expect(graph.a).not.toBe(graph.z[0])
  graph.a.changed = 'owned'
  expect(Object.hasOwn(shared, 'changed')).toBe(false)
  expect(Object.hasOwn(graph.z[0], 'changed')).toBe(false)
  expect(isDeepStrictEqual(second, expected)).toBe(true)
  expect(() => canonicalOutputJSONWithInlineRecords(input, { bytes: bytes - 1 })).toThrow(
    'byte limit'
  )
  expect(() => ownOutputJSONWithInlineRecords(input, { bytes: bytes - 1 })).toThrow('byte limit')
  expect(ownOutputJSONWithInlineRecords({ revised: ['after failure'] })).toEqual(
    ownOutputJSON({ revised: ['after failure'] })
  )
})

test('recursive inline records retain descriptor observations and refusal before any getter', () => {
  const observes = (operation: (input: unknown) => unknown): string[] => {
    const events: string[] = [],
      input = new Proxy(
        { rows: [{ value: 'ascii' }] },
        {
          getPrototypeOf(target) {
            events.push('prototype')
            return Reflect.getPrototypeOf(target)
          },
          ownKeys(target) {
            events.push('keys')
            return Reflect.ownKeys(target)
          },
          getOwnPropertyDescriptor(target, key) {
            events.push('descriptor:' + String(key))
            return Reflect.getOwnPropertyDescriptor(target, key)
          }
        }
      )
    operation(input)
    return events
  }
  expect(observes(canonicalOutputJSONWithInlineRecords)).toEqual(observes(canonicalOutputJSON))
  expect(observes(ownOutputJSONWithInlineRecords)).toEqual(observes(ownOutputJSON))
  let reads = 0
  const accessor = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        reads++
        return 'never'
      }
    }),
    cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const input of [
    accessor,
    cycle,
    Object.assign([], { 1: 1 }),
    Object.assign([1], { extra: true }),
    { bad: '\uD800' },
    { [Symbol('hidden')]: true },
    { n: 1.5 },
    Object.defineProperty({}, 'hidden', { value: 1 })
  ]) {
    expect(() => canonicalOutputJSONWithInlineRecords(input)).toThrow()
    expect(() => ownOutputJSONWithInlineRecords(input)).toThrow()
  }
  expect(reads).toBe(0)
})

test('owned-record lexical traversal accepts exactly the four JSON whitespace units', () => {
  for (const whitespace of [' ', '\r', '\n', '\t', ' \r\n\t']) {
    const source = `${whitespace}{${whitespace}"rows"${whitespace}:${whitespace}[${whitespace}1${whitespace}]${whitespace}}${whitespace}`
    for (const input of [source, new TextEncoder().encode(source)]) {
      expect(
        isDeepStrictEqual(parseOutputJSONWithOwnedRecords(input), parseOutputJSON(input))
      ).toBe(true)
      expect(
        isDeepStrictEqual(
          inspectOutputJSONEncodingWithOwnedRecords(input),
          inspectOutputJSONEncoding(input)
        )
      ).toBe(true)
    }
  }
  for (const forbidden of ['\v', '\f', '\u0085', '\u00a0']) {
    for (const source of [forbidden + '{}', '{}' + forbidden]) {
      expect(() => parseOutputJSONWithOwnedRecords(source)).toThrow()
      expect(() => parseOutputJSON(source)).toThrow()
      expect(() => inspectOutputJSONEncodingWithOwnedRecords(source)).toThrow()
    }
    expect(parseOutputJSONWithOwnedRecords('\t{ "valid": [1] }\r\n')).toEqual(
      parseOutputJSON('\t{ "valid": [1] }\r\n')
    )
  }
})

test('owned-record traversal preserves UTF-16 order for integer, builtin and astral names', () => {
  const input: Record<string, unknown> = Object.create(null)
  for (const [name, value] of [
    ['\uE000', 'bmp'],
    ['\u{1F600}', 'astral'],
    ['2', 'two'],
    ['10', 'ten'],
    ['a', 'first'],
    ['__proto__', 'builtin']
  ])
    Object.defineProperty(input, name, { value, enumerable: true, configurable: true })
  const expected =
    '{"10":"ten","2":"two","__proto__":"builtin","a":"first","\u{1F600}":"astral","\uE000":"bmp"}'
  expect(canonicalOutputJSON(input)).toBe(expected)
  expect(canonicalOutputJSONWithInlineRecords(input)).toBe(expected)
  const owned = ownOutputJSONWithInlineRecords(input)
  expect(owned.text).toBe(expected)
  expect(Object.getPrototypeOf(owned.value)).toBeNull()
  expect(isDeepStrictEqual(owned.value, ownOutputJSON(input).value)).toBe(true)
  Object.defineProperty(input, 'hidden', { value: 'refuse' })
  expect(() => canonicalOutputJSONWithInlineRecords(input)).toThrow()
  expect(() => ownOutputJSONWithInlineRecords(input)).toThrow()
  expect(owned.text).toBe(expected)
})

it('composes fresh owned children and independently frames text or byte representations', () => {
  const grammar = s.fixedObject({ count: s.u32 })
  const child = s.fromOwnedParent(value => s.normalizedWithInlineStrings(value, grammar), grammar)
  const parent = s.fixedObject({ left: child, right: child })
  const supplied = { count: 7 }
  const result = s.normalizedWithInlineStrings({ left: supplied, right: supplied }, parent)
  expect(result.left).toEqual({ count: 7 })
  expect(result.left).not.toBe(supplied)
  expect(result.left).not.toBe(result.right)
  owned(result)
  supplied.count = 8
  expect(result.left.count).toBe(7)
  expect(
    s.normalizedWithInlineStrings({ left: supplied, right: supplied }, parent).left.count
  ).toBe(8)
  const bytes = new TextEncoder().encode('{"count":7}')
  const framed = child(bytes)
  bytes[9] = 56
  expect(framed.count).toBe(7)
  expect(child(bytes).count).toBe(8)
  for (const representation of [
    '{"count":7,"count":8}',
    new TextEncoder().encode('{"count":7,"count":8}'),
    Uint8Array.from([255])
  ]) {
    expect(() => child(representation)).toThrow()
    expect(child('{"count":7}')).toEqual({ count: 7 })
  }
  let observed = false
  const accessor = Object.defineProperty({}, 'count', {
    enumerable: true,
    get() {
      observed = true
      return 7
    }
  })
  expect(() => s.normalizedWithInlineStrings({ left: accessor, right: supplied }, parent)).toThrow()
  expect(observed).toBe(false)
})

it('owns opt-in encoded input directly while retaining complete ordinary parser outcomes', () => {
  const outcome = (call: () => unknown): unknown => {
    try {
      return { value: call() }
    } catch (error) {
      return {
        name: (error as Error).name,
        code: (error as { code?: unknown }).code,
        message: (error as Error).message
      }
    }
  }
  const sources = [
    'null',
    'true',
    '-0',
    '1e3',
    '[1,2,3]',
    '{"z":"é😀","2":{"constructor":[]},"10":"data"}',
    '{"a":"\u0061","b":[{"c":"\ud83d\ude00"}]}',
    '{"a":1,"\u0061":2}',
    '"\ud800"',
    '[1,]',
    '{"a":1} trailing'
  ]
  for (const source of sources) {
    for (const input of [source, new TextEncoder().encode(source)]) {
      expect(outcome(() => s.normalizedWithInlineStrings(input, s.json))).toEqual(
        outcome(() => s.normalized(input, s.json))
      )
    }
  }
  const source = '{"a":[{"b":"unchanged"}]}'
  const first = s.normalizedWithInlineStrings(source, s.json) as { a: { b: string }[] }
  const second = s.normalizedWithInlineStrings(source, s.json)
  owned(first)
  owned(second)
  first.a[0].b = 'changed'
  expect(second).toEqual({ a: [{ b: 'unchanged' }] })
  for (const bound of [2, 3, source.length - 1, source.length])
    expect(outcome(() => s.normalizedWithInlineStrings(source, s.json, bound))).toEqual(
      outcome(() => s.normalized(source, s.json, bound))
    )
  expect(s.normalizedWithInlineStrings('1e3', s.json, 3)).toBe(1000)
  const valid = 'r'.repeat(16)
  expect(s.requestId(valid)).toBe(valid)
  for (const suffix of ['\n', '\r', '\u2028', '\u2029'])
    expect(() => s.requestId(valid + suffix)).toThrow()
})

test('explicit encoded-record schema ownership preserves complete refusal order and fresh graphs', () => {
  const outcome = (parse: typeof s.normalized, input: unknown, maximumBytes?: number) => {
    try {
      return { value: parse(input, s.json, maximumBytes) }
    } catch (error) {
      const e = error as Error & { code: string }
      return { name: e.name, code: e.code, message: e.message }
    }
  }
  for (const text of [
    'null',
    '1e3',
    '-0',
    '{"rows":[{"constructor":"é😀"}]}',
    '{"a":1,"\\u0061":2}',
    '{"x":"\\uD800"}',
    '{"x":1} trailing',
    '[1,]',
    '{"x":9007199254740992}'
  ]) {
    for (const input of [text, new TextEncoder().encode(text)]) {
      expect(outcome(s.normalizedWithOwnedRecords, input)).toStrictEqual(
        outcome(s.normalizedWithInlineStrings, input)
      )
      expect(outcome(s.normalizedWithOwnedRecords, input, 3)).toStrictEqual(
        outcome(s.normalizedWithInlineStrings, input, 3)
      )
    }
  }
  const source = '{"rows":[{"constructor":"unchanged"}]}'
  const first = s.normalizedWithOwnedRecords(source, s.json) as { rows: { constructor: string }[] }
  const second = s.normalizedWithOwnedRecords(source, s.json)
  owned(first)
  owned(second)
  first.rows[0].constructor = 'changed'
  expect(second).toStrictEqual(s.normalizedWithInlineStrings(source, s.json))
  expect(first).not.toBe(second)
})

import { canonicalOutputJSONWithDirectRecords } from '../OutputProtocolJSON.js'

test('direct canonical records retain refusal order, descriptors, numeric-key order and fresh observations', () => {
  function outcome(input: unknown, limits = {}) {
    function attempt(write: typeof canonicalOutputJSON) {
      try {
        return { text: write(input, limits) }
      } catch (error) {
        const refusal = error as Error & { code?: string }
        return { code: refusal.code, message: refusal.message }
      }
    }
    expect(attempt(canonicalOutputJSONWithDirectRecords)).toEqual(
      attempt(canonicalOutputJSONWithInlineRecords)
    )
    expect(attempt(canonicalOutputJSONWithDirectRecords)).toEqual(attempt(canonicalOutputJSON))
  }
  const valid = {
    '2': false,
    '10': null,
    '0': -0,
    é: ['😀', '\n', true],
    ['__proto__']: 'ordinary own data'
  }
  outcome(valid)
  expect(canonicalOutputJSONWithDirectRecords({ '2': 2, '10': 10 })).toBe('{"10":10,"2":2}')
  outcome(runInNewContext('({ a: [0, "é"], constructor: "ordinary" })'))
  for (const value of [
    undefined,
    1.5,
    Number.NaN,
    Infinity,
    new Date(),
    new Map(),
    { a: undefined },
    { a: '\uD800' },
    { '\uDC00': 'bad' }
  ])
    outcome(value)
  const cycle: { child?: unknown } = {}
  cycle.child = cycle
  outcome(cycle)
  const sparse = [1, 2]
  Reflect.deleteProperty(sparse, '0')
  outcome(sparse)
  outcome(Object.assign([1], { extra: 2 }))
  outcome(Object.defineProperty({}, 'hidden', { value: 1 }))
  outcome({ [Symbol('key')]: 1 })
  let reads = 0
  outcome(
    Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads++
        return 1
      }
    })
  )
  expect(reads).toBe(0)
  outcome({ rows: [[1]] }, { depth: 2 })
  outcome({ a: 1, b: 2 }, { mapKeys: 1 })
  outcome([1, 2], { arrayElements: 1 })
  outcome({ a: 'too long', z: undefined }, { bytes: 6 })
  const changing = { value: 1 }
  expect(canonicalOutputJSONWithDirectRecords(changing)).toBe('{"value":1}')
  changing.value = 2
  expect(canonicalOutputJSONWithDirectRecords(changing)).toBe('{"value":2}')
})

function ownedSchemaOutcome(call: () => unknown): unknown {
  try {
    return { value: call() }
  } catch (error) {
    const refusal = error as Error & { code?: string }
    return { name: refusal.name, code: refusal.code, message: refusal.message }
  }
}

test('server grammar owns the complete representation before invoking any custom predicate', () => {
  const o = s.createOwnedRecordSchema()
  let calls = 0,
    reads = 0
  const schema = o.fixedObject({
    value: value => {
      calls++
      return s.u32(value)
    }
  })
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      reads++
      return 1
    }
  })
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  for (const input of [
    accessor,
    cyclic,
    { value: 1, later: undefined },
    { value: 1, later: '\uD800' },
    { value: 1, [Symbol('later')]: true },
    Object.defineProperty({ value: 1 }, 'hidden', { value: true }),
    '{"value":1,"\\u0076alue":2}',
    new TextEncoder().encode('{"value":1} trailing'),
    Uint8Array.from([255])
  ]) {
    expect(() => o.normalized(input, schema)).toThrow()
  }
  expect(() => o.normalized({ value: 1 }, schema, 1)).toThrow('byte limit')
  expect(calls).toBe(0)
  expect(reads).toBe(0)
  expect(o.normalized({ value: 1 }, schema)).toEqual({ value: 1 })
  expect(calls).toBe(1)
})

test('server grammar preserves nested field, scalar, tag and array outcomes for all representations', () => {
  const o = s.createOwnedRecordSchema()
  function grammar(tools: typeof o) {
    return tools.fixedObject(
      {
        rows: tools.array(
          tools.fixedObject({
            count: tools.u32,
            total: tools.u64,
            kind: tools.literal('item'),
            enabled: tools.bool,
            note: tools.nullable(tools.text)
          }),
          2,
          1
        ),
        chain: tools.chain
      },
      { metadata: tools.jsonMap }
    )
  }
  const ordinary = s.fixedObject(
    {
      rows: s.array(
        s.fixedObject({
          count: s.u32,
          total: s.u64,
          kind: s.literal('item'),
          enabled: s.bool,
          note: s.nullable(s.text)
        }),
        2,
        1
      ),
      chain: s.chain
    },
    { metadata: s.jsonMap }
  )
  const selected = grammar(o)
  const valid = {
    rows: [
      { count: 4294967295, total: '18446744073709551615', kind: 'item', enabled: true, note: null }
    ],
    chain,
    metadata: { constructor: 'é😀' }
  }
  const inputs = [
    valid,
    { ...valid, extra: true },
    { ...valid, rows: [] },
    { ...valid, rows: Array.from({ length: 3 }, () => valid.rows[0]) },
    ...[
      { count: -1 },
      { total: '01' },
      { kind: 'other' },
      { enabled: 1 },
      { note: 1 },
      { extra: true }
    ].map(change => ({ ...valid, rows: [{ ...valid.rows[0], ...change }] })),
    { rows: valid.rows },
    { ...valid, chain: { ...chain, genesisHash: 'AA'.repeat(32) } }
  ]
  for (const input of inputs) {
    const text = JSON.stringify(input)
    for (const value of [input, text, new TextEncoder().encode(text)]) {
      expect(ownedSchemaOutcome(() => o.normalized(value, selected))).toStrictEqual(
        ownedSchemaOutcome(() => s.normalizedWithOwnedRecords(value, ordinary))
      )
    }
  }
  owned(o.normalized(valid, selected))
})

test('server grammar never reuses supplied graphs or predicate results across calls', () => {
  const o = s.createOwnedRecordSchema()
  let allowed = true,
    calls = 0
  const schema = o.fixedObject({
    child: o.fixedObject({ count: o.u32 }),
    authorized: value => {
      calls++
      if (!allowed) throw new Error('Current policy refused')
      return s.bool(value)
    }
  })
  const supplied = { child: { count: 1 }, authorized: true }
  const first = o.normalized(supplied, schema),
    second = o.normalized(supplied, schema)
  first.child.count = 9
  expect(second.child.count).toBe(1)
  expect(supplied.child.count).toBe(1)
  supplied.child.count = 2
  expect(o.normalized(supplied, schema).child.count).toBe(2)
  allowed = false
  expect(() => o.normalized(supplied, schema)).toThrow('Current policy refused')
  expect(calls).toBe(4)
  expect(first).not.toBe(second)
  owned(second)
})

test('server fixed callbacks still reject unsafe standalone objects after successful normalization', () => {
  const o = s.createOwnedRecordSchema(),
    schema = o.fixedObject({ value: o.u32 })
  expect(o.normalized({ value: 1 }, schema)).toEqual({ value: 1 })
  for (const input of [
    Object.create({ value: 1 }),
    Object.defineProperty({}, 'value', { value: 1 }),
    { value: 1, [Symbol('other')]: true },
    Object.defineProperty({ value: 1 }, 'extra', { value: true }),
    null,
    [],
    1
  ]) {
    expect(ownedSchemaOutcome(() => schema(input))).toStrictEqual(
      ownedSchemaOutcome(() => s.fixedObject({ value: s.u32 })(input))
    )
  }
  expect(() => schema({ value: 1, extra: true })).toThrow('Unknown extra')
  expect(() => schema({})).toThrow('Missing value')
})

test('server fixed grammar snapshots names and callbacks without changing dynamic ordinary builders', () => {
  const o = s.createOwnedRecordSchema()
  const required: Record<string, s.Schema<unknown>> = { value: o.text }
  const optional: Record<string, s.Schema<unknown>> = { count: o.u32 }
  const fixed = o.fixedObject(required, optional),
    dynamic = s.object(required, optional)
  required.value = s.u32
  required.extra = s.bool
  optional.count = s.text
  expect(o.normalized({ value: 'original', count: 1 }, fixed)).toEqual({
    value: 'original',
    count: 1
  })
  expect(() => o.normalized({ value: 'original', extra: true }, fixed)).toThrow('Unknown extra')
  expect(dynamic({ value: 2, extra: true, count: 'current' })).toEqual({
    value: 2,
    extra: true,
    count: 'current'
  })
})

test('server array preserves custom map callback arguments and fresh later-item validation', () => {
  const o = s.createOwnedRecordSchema(),
    seen: unknown[] = []
  const custom: s.Schema<string> = (value: unknown, index?: number, values?: unknown[]) => {
    seen.push(index, values)
    if (index === 0) values![1] = 7
    return s.text(value)
  }
  const input = ['first', 'second']
  expect(() => o.normalized(input, o.array(custom, 2, 2))).toThrow('Expected bounded string')
  expect(seen[0]).toBe(0)
  expect(seen[2]).toBe(1)
  expect(seen[1]).toBe(seen[3])
  expect(seen[1]).not.toBe(input)
  expect(input).toEqual(['first', 'second'])
  for (const value of [null, [], ['one'], ['one', 'two', 'three']])
    expect(() => o.normalized(value, o.array(o.text, 2, 2))).toThrow()
})

test('server tagged alternatives retain mutable-table and custom-callback behavior on every call', () => {
  const o = s.createOwnedRecordSchema()
  const alternatives: Record<string, s.Schema<unknown>> = {
    a: o.fixedObject({ kind: o.literal('a'), value: o.text })
  }
  const schema = o.tagged('kind', alternatives)
  expect(o.normalized({ kind: 'a', value: 'first' }, schema)).toEqual({ kind: 'a', value: 'first' })
  let calls = 0
  alternatives.a = value => {
    calls++
    return s.fixedObject({ kind: s.literal('a'), value: s.u32 })(value)
  }
  expect(o.normalized({ kind: 'a', value: 2 }, schema)).toEqual({ kind: 'a', value: 2 })
  expect(() => o.normalized({ kind: 'a', value: 'old' }, schema)).toThrow()
  expect(calls).toBe(2)
  for (const value of [null, [], { kind: 'constructor' }, { kind: 1 }, { kind: 'missing' }])
    expect(() => o.normalized(value, schema)).toThrow()
})

test('server child composition independently frames embedded JSON and preserves ordinary custom children', () => {
  const o = s.createOwnedRecordSchema(),
    grammar = o.fixedObject({ count: o.u32 })
  const child = o.fromOwnedParent(value => s.normalizedWithOwnedRecords(value, grammar), grammar)
  const parent = o.fixedObject({ left: child, right: child }),
    supplied = { count: 7 }
  const value = o.normalized({ left: supplied, right: supplied }, parent)
  expect(value.left).not.toBe(value.right)
  expect(value.left).not.toBe(supplied)
  value.left.count = 9
  expect(value.right.count).toBe(7)
  expect(o.normalized({ left: '{"count":7}', right: supplied }, parent).left.count).toBe(7)
  for (const source of ['{"count":7,"\\u0063ount":8}', '{"count":7} trailing'])
    expect(() => o.normalized({ left: source, right: supplied }, parent)).toThrow()
  expect(child(new TextEncoder().encode('{"count":7}'))).toEqual({ count: 7 })
  const custom = o.fromOwnedParent(
    value => s.u32(Number(s.text(value))),
    value => s.u32(value)
  )
  expect(o.normalized(7, custom)).toBe(7)
  expect(o.normalized('"7"', custom)).toBe(7)
})
