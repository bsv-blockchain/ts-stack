import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

type Value = string | number | boolean | Value[] | { [key: string]: Value }
export interface CanonicalPortableChunkOptions {
  /** Allocation charge for one detached value, not the whole wallet. */
  maximumValueBytes: number
  /** A bounded output buffer; defaults to 65,536 bytes. */
  maximumChunkBytes?: number
  signal?: AbortSignal
}
interface State {
  remaining: number
  active: Set<object>
  signal: AbortSignal | undefined
}
interface DetachedValue {
  value: Value
}
function invalid(): never {
  throw new TypeError('Canonical portable values require finite JSON scalars without null or absent array entries')
}
function charge(state: State, bytes: number): void {
  state.signal?.throwIfAborted()
  state.remaining -= bytes
  if (state.remaining < 0)
    throw new SnapshotResourceLimitError('Canonical portable value exceeds its allocation budget')
}
function unicode(value: string, state: State): void {
  charge(state, 64 + 2 * value.length)
  for (let index = 0; index < value.length; index++) {
    if (index % 1024 === 0) state.signal?.throwIfAborted()
    const point = value.codePointAt(index)!
    if (point >= 0xd800 && point <= 0xdfff) invalid()
    if (point > 0xffff) index++
  }
}
function child(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid()
  return descriptor.value
}
function detachedObject(value: object, depth: number, state: State): { [key: string]: Value } {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) invalid()
  const result: { [key: string]: Value } = Object.create(null)
  // Stop before allocating an unbounded property-name array or invoking getters.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    unicode(key, state)
    result[key] = detach(child(value, key), depth + 1, state).value
  }
  return result
}
function detach(value: unknown, depth: number, state: State): DetachedValue {
  state.signal?.throwIfAborted()
  if (depth > 64) throw new SnapshotResourceLimitError('Canonical portable nesting exceeds 64 levels')
  if (typeof value === 'string') {
    unicode(value, state)
    return { value }
  }
  charge(state, 64)
  if (typeof value === 'boolean') return { value }
  if (typeof value === 'number' && Number.isFinite(value)) return { value }
  if (typeof value !== 'object' || value === null) invalid()
  if (state.active.has(value)) invalid()
  state.active.add(value)
  try {
    if (!Array.isArray(value)) return { value: detachedObject(value, depth, state) }
    // Every child costs at least 64 bytes; refuse impossible lengths before
    // allocating the detached array, with the caller's actual remaining budget.
    if (value.length > Math.floor(state.remaining / 64))
      throw new SnapshotResourceLimitError('Canonical portable array exceeds its allocation budget')
    const result: Value[] = []
    for (let index = 0; index < value.length; index++)
      result.push(detach(child(value, String(index)), depth + 1, state).value)
    return { value: result }
  } finally {
    state.active.delete(value)
  }
}
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
/** Serialization of ONE bounded, detached portable value. This does
 * not capture a coherent source, establish table closure, normalize stored
 * histories, stream native blobs or produce a complete BRC-38 archive alone.
 * No full escaped string or document byte array is retained. Callers must not
 * publish partially consumed output as a completed archive.
 */
export function* canonicalPortableChunks(
  input: unknown,
  options: CanonicalPortableChunkOptions
): Generator<Uint8Array> {
  const { maximumValueBytes, maximumChunkBytes = 65536, signal } = options
  if (!Number.isSafeInteger(maximumValueBytes) || maximumValueBytes < 1 || maximumValueBytes > 16777216)
    throw new RangeError('maximumValueBytes must be an integer from 1 to 16777216')
  if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 64 || maximumChunkBytes > 65536)
    throw new RangeError('maximumChunkBytes must be an integer from 64 to 65536')
  const value = detach(input, 0, { remaining: maximumValueBytes, active: new Set(), signal }).value
  const encoder = new TextEncoder()
  let buffer = new Uint8Array(maximumChunkBytes),
    used = 0
  for (const part of parts(value, Math.floor(maximumChunkBytes / 6) - 1)) {
    signal?.throwIfAborted()
    const bytes = encoder.encode(part)
    let offset = 0
    while (offset < bytes.length) {
      const count = Math.min(bytes.length - offset, maximumChunkBytes - used)
      buffer.set(bytes.subarray(offset, offset + count), used)
      used += count
      offset += count
      if (used === maximumChunkBytes) {
        yield buffer
        signal?.throwIfAborted()
        buffer = new Uint8Array(maximumChunkBytes)
        used = 0
      }
    }
  }
  signal?.throwIfAborted()
  if (used !== 0) yield buffer.slice(0, used)
}
