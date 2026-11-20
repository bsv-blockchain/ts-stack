import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { invalid, charge, unicode, type Value, type State, type DetachedValue } from './CanonicalPortableBounds'

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

export { detach }
