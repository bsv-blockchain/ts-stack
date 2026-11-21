import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import {
  canonicalTestReference,
  collectExpectedCanonicalChunks,
  type CanonicalTestValue
} from '../../../test/utils/canonicalPortableChunkOracle'

const options = { maximumValueBytes: 16777216, maximumChunkBytes: 64 }
function encoded(value: unknown, chunkBytes = 64): string {
  const chunks = collectExpectedCanonicalChunks(
    canonicalPortableChunks(value, { ...options, maximumChunkBytes: chunkBytes }),
    canonicalTestReference(value as CanonicalTestValue)
  )
  expect(chunks.every(chunk => chunk.byteLength > 0 && chunk.byteLength <= chunkBytes)).toBe(true)
  return Buffer.concat(chunks).toString('utf8')
}

test('preserves the RFC8785 number spelling and UTF16 property order', () => {
  const value = {
    numbers: [Number('333333333.33333329'), 1e30, 4.5, 0.002, 1e-27, -0, 5e-324],
    '\ud83d\ude00': 'emoji',
    '\ufb33': 'hebrew',
    '\u20ac': 'euro',
    '1': 'one',
    '\u0080': 'control',
    '\u00f6': 'latin',
    '\r': 'return'
  }
  expect(encoded(value)).toBe(
    '{"\\r":"return","1":"one","numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0,5e-324],"\u0080":"control","ö":"latin","€":"euro","😀":"emoji","דּ":"hebrew"}'
  )
})

test.each([64, 65, 127, 1024, 65536])('preserves exact escaped bytes across %i byte chunks', size => {
  const text = '😀"\\\u0000\n\t\b\f\r/é名字'.repeat(3000)
  expect(encoded({ text }, size)).toBe('{"text":' + JSON.stringify(text) + '}')
})

test('preserves distinct composed and decomposed Unicode values', () => {
  expect(encoded({ decomposed: 'e\u0301', composed: 'é' })).toBe('{"composed":"é","decomposed":"é"}')
})

test.each([null, undefined, NaN, Infinity, -Infinity, 1n, new Date(), new Uint8Array(2)])(
  'refuses unsupported portable values before yielding output: %p',
  value => {
    expect(() => canonicalPortableChunks(value, options).next()).toThrow(TypeError)
  }
)

test.each(['\ud800', '\udfff', 'prefix\ud800suffix', '\udfff\ud800'])('refuses lone surrogates: %p', text => {
  expect(() => canonicalPortableChunks({ text }, options).next()).toThrow(TypeError)
  expect(() => canonicalPortableChunks({ [text]: 'value' }, options).next()).toThrow(TypeError)
})

test('refuses nulls, undefined and holes instead of dropping array positions', () => {
  const hole: unknown[] = []
  hole.length = 1
  for (const value of [[null], [undefined], hole, { missing: undefined }, { empty: null }])
    expect(() => canonicalPortableChunks(value, options).next()).toThrow(TypeError)
})

test('does not invoke getters while inspecting portable objects or arrays', () => {
  const get = jest.fn(() => 'untrusted')
  const object = Object.defineProperty({}, 'value', { get, enumerable: true })
  const array = Object.defineProperty([], '0', { get, enumerable: true })
  for (const value of [object, array]) expect(() => canonicalPortableChunks(value, options).next()).toThrow(TypeError)
  expect(get).not.toHaveBeenCalled()
})

test('refuses cycles but permits repeated detached values', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(() => canonicalPortableChunks(cycle, options).next()).toThrow(TypeError)
  const same = { a: 1 }
  expect(encoded([same, same])).toBe('[{"a":1},{"a":1}]')
})

test('keeps prototype-like property names as ordinary portable data', () => {
  const value: unknown = JSON.parse('{"__proto__":{"x":1},"constructor":"value","toString":false}')
  expect(encoded(value)).toBe('{"__proto__":{"x":1},"constructor":"value","toString":false}')
})

test('detaches every value before yielding so caller mutations do not change later output', () => {
  const original = { prefix: 'x'.repeat(300), suffix: { values: ['before', false, 0] } }
  const expected = encoded(original)
  const iterator = canonicalPortableChunks(original, options)
  const first = iterator.next()
  expect(first.done).toBe(false)
  original.prefix = 'changed'
  original.suffix.values.splice(0, 3, 'after')
  const chunks = [
    first.value as Uint8Array,
    ...collectExpectedCanonicalChunks(iterator, Buffer.from(expected).subarray(first.value!.byteLength))
  ]
  expect(Buffer.concat(chunks).toString('utf8')).toBe(expected)
})

test('never reuses buffers already returned to the caller', () => {
  const text = 'abc'.repeat(2000)
  const chunks = collectExpectedCanonicalChunks(canonicalPortableChunks({ text }, options), JSON.stringify({ text }))
  expect(new Set(chunks.map(chunk => chunk.buffer)).size).toBe(chunks.length)
  const before = Buffer.concat(chunks.slice(1))
  chunks[0].fill(0)
  expect(Buffer.concat(chunks.slice(1))).toEqual(before)
})

test('enforces allocation and nesting limits before yielding', () => {
  expect(() => canonicalPortableChunks('x', { maximumValueBytes: 65 }).next()).toThrow(SnapshotResourceLimitError)
  expect(collectExpectedCanonicalChunks(canonicalPortableChunks('x', { maximumValueBytes: 66 }), '"x"')).toHaveLength(1)
  expect(() => canonicalPortableChunks([true], { maximumValueBytes: 127 }).next()).toThrow(SnapshotResourceLimitError)
  expect(encoded([true])).toBe('[true]')
  let deep: unknown = true
  for (let index = 0; index < 65; index++) deep = [deep]
  expect(() => canonicalPortableChunks(deep, options).next()).toThrow(SnapshotResourceLimitError)
})

test.each(['divergent', 'extra', 'empty'] as const)(
  'the independent chunk consumer rejects %s output promptly and drains its iterator',
  kind => {
    let pulls = 0,
      closed = false
    function* broken(): Generator<Uint8Array> {
      try {
        while (pulls < 3) {
          pulls++
          yield Buffer.from(kind === 'empty' ? '' : kind === 'extra' && pulls === 1 ? '"a"' : '{')
        }
      } finally {
        closed = true
      }
    }
    expect(() => collectExpectedCanonicalChunks(broken(), '"a"')).toThrow()
    expect(pulls).toBe(kind === 'extra' ? 2 : 1)
    expect(closed).toBe(true)
  }
)

test('admits large structured sync maps using the allocation budget rather than a small fixed member limit', () => {
  const idMap: Record<string, number> = {}
  for (let index = 0; index < 1000; index++) idMap[String(index)] = 1000 - index
  const expected =
    '{"idMap":{' +
    Object.keys(idMap)
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map(key => JSON.stringify(key) + ':' + idMap[key])
      .join(',') +
    '}}'
  expect(encoded({ idMap })).toBe(expected)
  expect(() => canonicalPortableChunks({ idMap }, { maximumValueBytes: 1000 }).next()).toThrow(
    SnapshotResourceLimitError
  )
})

test.each([0, -1, 0.5, NaN, 16777217])('rejects invalid value budgets: %p', maximumValueBytes => {
  expect(() => canonicalPortableChunks(true, { maximumValueBytes }).next()).toThrow(RangeError)
})
test.each([0, 63, 65537, 1.5, NaN])('rejects invalid chunk budgets: %p', maximumChunkBytes => {
  expect(() => canonicalPortableChunks(true, { maximumValueBytes: 1024, maximumChunkBytes }).next()).toThrow(RangeError)
})

test('preserves the exact cancellation reason before work and between output chunks', () => {
  const reason = new Error('synthetic caller cancellation')
  const early = new AbortController()
  early.abort(reason)
  expect(() => canonicalPortableChunks('x', { ...options, signal: early.signal }).next()).toThrow(reason)
  const later = new AbortController()
  const iterator = canonicalPortableChunks('x'.repeat(300), { ...options, signal: later.signal })
  expect(iterator.next().done).toBe(false)
  later.abort(reason)
  try {
    iterator.next()
    throw new Error('expected cancellation')
  } catch (error) {
    expect(error).toBe(reason)
  }
})

test('reports canonical validation errors for absent entries and every unsupported scalar kind', () => {
  const message = 'Canonical portable values require finite JSON scalars without null or absent array entries',
    hole = Array<unknown>(1)
  for (const value of [hole, null, undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => true]) {
    const first = () => canonicalPortableChunks(value, options).next()
    expect(first).toThrow(TypeError)
    expect(first).toThrow(message)
  }
})

test('admits exactly sixty-four nesting levels for arrays and object members', () => {
  for (const kind of ['array', 'object']) {
    let value: unknown = true,
      expected = 'true'
    for (let depth = 0; depth < 64; depth++) {
      value = kind === 'array' ? [value] : { child: value }
      expected = kind === 'array' ? '[' + expected + ']' : '{"child":' + expected + '}'
    }
    expect(encoded(value)).toBe(expected)
    const tooDeep = kind === 'array' ? [value] : { child: value }
    expect(() => canonicalPortableChunks(tooDeep, options).next()).toThrow(
      'Canonical portable nesting exceeds 64 levels'
    )
  }
})

test('admits an exact array allocation and refuses an impossible array before inspecting its children', () => {
  const exact = canonicalPortableChunks([true], { maximumValueBytes: 128 })
  expect(Buffer.concat([...exact]).toString()).toBe('[true]')
  const get = jest.fn(() => true),
    array = Object.defineProperty([], '0', { enumerable: true, get })
  expect(() => canonicalPortableChunks(array, { maximumValueBytes: 127 }).next()).toThrow(
    'Canonical portable array exceeds its allocation budget'
  )
  expect(get).not.toHaveBeenCalled()
})

test('preserves the terminal BMP code unit before an independently invalid surrogate', () => {
  expect(encoded('\uffff😀\uffff')).toBe(JSON.stringify('\uffff😀\uffff'))
  expect(() => canonicalPortableChunks('\uffff\ud800', options).next()).toThrow(TypeError)
  expect(() => canonicalPortableChunks({ ['\uffff\udfff']: true }, options).next()).toThrow(TypeError)
})

test('retains useful option errors before allocating or consuming a value', () => {
  expect(() => canonicalPortableChunks(true, { maximumValueBytes: 0 }).next()).toThrow(
    'maximumValueBytes must be an integer from 1 to 16777216'
  )
  expect(() => canonicalPortableChunks(true, { ...options, maximumChunkBytes: 63 }).next()).toThrow(
    'maximumChunkBytes must be an integer from 64 to 65536'
  )
})

test('bounds escaped encoding windows as well as the returned buffers', () => {
  const original = TextEncoder.prototype.encode,
    windows: number[] = [],
    observe = jest.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      input?: string
    ) {
      const bytes = original.call(this, input)
      windows.push(bytes.byteLength)
      return bytes
    })
  try {
    const value = '\u0000'.repeat(2048) + '😀'.repeat(100)
    expect(encoded(value)).toBe(JSON.stringify(value))
    expect(windows.length).toBeGreaterThan(1)
    expect(Math.max(...windows)).toBeLessThanOrEqual(options.maximumChunkBytes)
  } finally {
    observe.mockRestore()
  }
})
