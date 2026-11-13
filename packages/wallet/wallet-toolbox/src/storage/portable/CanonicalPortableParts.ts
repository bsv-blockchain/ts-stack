import type { Value } from './CanonicalPortableBounds'

function* stringParts(value: string, width: number): Generator<string> {
  yield '"'
  let offset = 0
  while (offset < value.length) {
    let end = Math.min(value.length, offset + width)
    const tail = value.codePointAt(end - 1)!
    if (end < value.length && tail > 0xffff) end++
    // ECMAScript escaping on a bounded window preserves JCS scalar spelling.
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
    offset = end
  }
  yield '"'
}
function compareUtf16(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}
function* parts(value: Value, width: number): Generator<string> {
  if (typeof value === 'string') yield* stringParts(value, width)
  else if (typeof value === 'number' || typeof value === 'boolean') yield JSON.stringify(value)
  else if (Array.isArray(value)) {
    yield '['
    for (let index = 0; index < value.length; index++) {
      if (index !== 0) yield ','
      yield* parts(value[index], width)
    }
    yield ']'
  } else {
    yield '{'
    // RFC8785 orders raw UTF16 units, independently of locale.
    const keys = Object.keys(value).sort(compareUtf16)
    for (let index = 0; index < keys.length; index++) {
      if (index !== 0) yield ','
      yield* stringParts(keys[index], width)
      yield ':'
      yield* parts(value[keys[index]], width)
    }
    yield '}'
  }
}

export { parts }
