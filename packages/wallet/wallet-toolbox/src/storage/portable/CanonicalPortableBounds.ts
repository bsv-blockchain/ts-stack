import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export type Value = string | number | boolean | Value[] | { [key: string]: Value }
export interface State {
  remaining: number
  active: Set<object>
  signal: AbortSignal | undefined
}
export interface DetachedValue {
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

export { invalid, charge, unicode }
