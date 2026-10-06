import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const options = { maximumValueBytes: 16777216, maximumChunkBytes: 64 }
function encoded(value: unknown, chunkBytes = 64): string {
  const chunks = [...canonicalPortableChunks(value, { ...options, maximumChunkBytes: chunkBytes })]
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
  const chunks = [first.value as Uint8Array, ...iterator]
  expect(Buffer.concat(chunks).toString('utf8')).toBe(expected)
})

test('never reuses buffers already returned to the caller', () => {
  const text = 'abc'.repeat(2000)
  const chunks = [...canonicalPortableChunks({ text }, options)]
  expect(new Set(chunks.map(chunk => chunk.buffer)).size).toBe(chunks.length)
  const before = Buffer.concat(chunks.slice(1))
  chunks[0].fill(0)
  expect(Buffer.concat(chunks.slice(1))).toEqual(before)
})

test('enforces allocation and nesting limits before yielding', () => {
  expect(() => canonicalPortableChunks('x', { maximumValueBytes: 65 }).next()).toThrow(SnapshotResourceLimitError)
  expect([...canonicalPortableChunks('x', { maximumValueBytes: 66 })]).toHaveLength(1)
  expect(() => canonicalPortableChunks([true], { maximumValueBytes: 127 }).next()).toThrow(SnapshotResourceLimitError)
  expect(encoded([true])).toBe('[true]')
  let deep: unknown = true
  for (let index = 0; index < 65; index++) deep = [deep]
  expect(() => canonicalPortableChunks(deep, options).next()).toThrow(SnapshotResourceLimitError)
})

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
