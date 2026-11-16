import { nativeMergeExpectedJson } from './Brc38NativeMergeExpectedFixture'

// Literal canonical bytes are independent of both the expected-value helper
// and the production streamed encoder. These are fixture serialization tests,
// not native ownership, recovery, resource or all47 qualification evidence.
test.each([
  [{ 13: 13, 113: 1601 }, '{"113":1601,"13":13}'],
  [{ idMap: { 13: 13, 113: 1601 } }, '{"idMap":{"113":1601,"13":13}}'],
  [{ 2: 2, 10: 10, 0: 0, '00': 7, 4294967295: 8 }, '{"0":0,"00":7,"10":10,"2":2,"4294967295":8}'],
  [{ '\uffff': 2, '😀': 1 }, '{"😀":1,"\uffff":2}'],
  [[{ 13: 13, 113: 1601 }, null, true, 0, 'x\n'], '[{"113":1601,"13":13},null,true,0,"x\\n"]']
])('independent native expected JSON preserves literal canonical bytes: case%#', (value, expected) => {
  expect(nativeMergeExpectedJson(value)).toBe(expected)
})

test('independent native expected JSON refuses an absent scalar instead of omitting it', () => {
  expect(() => nativeMergeExpectedJson(undefined)).toThrow('serializable data')
})
