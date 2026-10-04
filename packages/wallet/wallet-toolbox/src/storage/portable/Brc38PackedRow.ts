import { Utils } from '@bsv/sdk'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import type { BRC38Tables } from './index'

type Value = string | number | boolean | Value[] | { [key: string]: Value }
type Kind = keyof BRC38Tables | 'sourceStorage' | 'user'
export interface Brc38PackedRowOptions {
  /** Combined conservative charge for stored structured JSON, parsed nodes and
   * the detached portable row. This is not encoded size or process RSS. */
  maximumAllocationBytes: number
  signal?: AbortSignal
}
interface Detached {
  value: Value
}
interface Lexical {
  quoted: boolean
  escaped: boolean
  atom: boolean
  depth: number
}
interface State {
  remaining: number
  active: Set<object>
  signal?: AbortSignal
}
const binary: Partial<Record<Kind, readonly string[]>> = {
  commissions: ['lockingScript'],
  outputs: ['lockingScript'],
  provenTxs: ['merklePath', 'rawTx'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['inputBEEF', 'rawTx']
}
const structured: Partial<Record<Kind, readonly string[]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
const entities = new Set([
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
])
function invalid(): never {
  throw new TypeError('BRC-38 packed rows require plain data properties and finite portable values')
}
function charge(state: State, bytes: number): void {
  state.signal?.throwIfAborted()
  if (bytes > state.remaining) throw new SnapshotResourceLimitError('BRC-38 row exceeds its allocation policy')
  state.remaining -= bytes
}
function text(value: string, state: State): string {
  charge(state, 64 + 2 * value.length)
  for (let index = 0; index < value.length; index++) {
    if (index % 1024 === 0) state.signal?.throwIfAborted()
    const point = value.codePointAt(index)!
    if (point >= 0xd800 && point <= 0xdfff) invalid()
    if (point > 0xffff) index++
  }
  return value
}
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid()
  return descriptor.value
}
function plain(value: object): void {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && (typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== null)) invalid()
}
function optional(field: string, path: readonly (string | number)[]): boolean {
  if (field === 'history')
    return (
      (path.length === 1 && path[0] === 'notes') ||
      (path.length === 3 && path[0] === 'notes' && typeof path[1] === 'number' && path[2] !== 'what')
    )
  if (field === 'notify') return path.length === 1 && path[0] === 'transactionIds'
  if (field === 'syncMap') return path.length === 2 && entities.has(String(path[0])) && path[1] === 'maxUpdated_at'
  return (field === 'errorLocal' || field === 'errorOther') && path.length === 1 && path[0] === 'stack'
}
function objectValue(value: object, state: State, field: string, path: readonly (string | number)[], depth: number) {
  plain(value)
  const result: { [key: string]: Value } = Object.create(null)
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    text(key, state)
    const child = data(value, key),
      childPath = [...path, key]
    if (child == null && optional(field, childPath)) continue
    result[key] = detached(child, state, field, childPath, depth + 1).value
  }
  return result
}
function arrayValue(value: unknown[], state: State, field: string, path: readonly (string | number)[], depth: number) {
  if (value.length > Math.floor(state.remaining / 64))
    throw new SnapshotResourceLimitError('BRC-38 array exceeds its allocation policy')
  const result: Value[] = []
  for (let index = 0; index < value.length; index++)
    result.push(detached(data(value, String(index)), state, field, [...path, index], depth + 1).value)
  return result
}
function detached(
  value: unknown,
  state: State,
  field: string,
  path: readonly (string | number)[],
  depth: number
): Detached {
  if (depth > 64) throw new SnapshotResourceLimitError('BRC-38 row nesting exceeds 64 levels')
  if (typeof value === 'string') return { value: text(value, state) }
  charge(state, 64)
  if (typeof value === 'boolean') return { value }
  if (typeof value === 'number' && Number.isFinite(value)) return { value }
  if (value === null || typeof value !== 'object' || state.active.has(value)) invalid()
  state.active.add(value)
  try {
    return {
      value: Array.isArray(value)
        ? arrayValue(value, state, field, path, depth)
        : objectValue(value, state, field, path, depth)
    }
  } finally {
    state.active.delete(value)
  }
}
/** Admission before JSON.parse: raw UTF-16 size, each possible parsed node and
 * nesting are bounded before the parser can allocate. This scanner is not a
 * syntax validator; JSON.parse still rejects every malformed input. */
function structural(unit: string, lexical: Lexical, state: State): void {
  if (unit === '"') {
    charge(state, 64)
    lexical.quoted = true
    lexical.atom = false
  } else if (unit === '[' || unit === '{') {
    charge(state, 64)
    lexical.depth++
    lexical.atom = false
    if (lexical.depth > 64) throw new SnapshotResourceLimitError('BRC-38 stored JSON nesting exceeds 64 levels')
  } else if (unit === ']' || unit === '}') {
    lexical.depth--
    lexical.atom = false
  } else if (unit === ',' || unit === ':' || /\s/.test(unit)) lexical.atom = false
  else if (!lexical.atom) {
    charge(state, 64)
    lexical.atom = true
  }
}
function parsed(value: string, state: State): unknown {
  charge(state, 64 + 2 * value.length)
  const lexical: Lexical = { quoted: false, escaped: false, atom: false, depth: 1 }
  for (let index = 0; index < value.length; index++) {
    if (index % 1024 === 0) state.signal?.throwIfAborted()
    const unit = value[index]
    if (!lexical.quoted) structural(unit, lexical, state)
    else if (lexical.escaped) lexical.escaped = false
    else if (unit === '\\') lexical.escaped = true
    else if (unit === '"') lexical.quoted = false
  }
  state.signal?.throwIfAborted()
  return JSON.parse(value)
}
function base64(value: unknown, state: State): string {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
  const length = value.length
  charge(state, 64 + 8 * Math.ceil(length / 3))
  const parts: string[] = []
  for (let offset = 0; offset < length; offset += 3072) {
    state.signal?.throwIfAborted()
    const window: number[] = []
    for (let index = offset; index < Math.min(length, offset + 3072); index++) {
      const byte = value instanceof Uint8Array ? value[index] : data(value, String(index))
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) invalid()
      window.push(byte)
    }
    parts.push(Utils.toBase64(window))
  }
  return parts.join('')
}
function dateValue(value: unknown): boolean {
  try {
    Date.prototype.getTime.call(value)
    return true
  } catch {
    return false
  }
}
function fieldValue(kind: Kind, key: string, value: unknown, state: State): Detached {
  if (binary[kind]?.includes(key)) return { value: base64(value, state) }
  if (structured[kind]?.includes(key)) {
    const source = typeof value === 'string' ? parsed(value, state) : value
    if (source === null || typeof source !== 'object' || Array.isArray(source)) invalid()
    return detached(source, state, key, [], 1)
  }
  if (dateValue(value)) return { value: text(Date.prototype.toISOString.call(value), state) }
  // PackedSnapshotRow also retains legacy number arrays that are not standard
  // base64 columns. Expand only this bounded row, preserving their JSON shape.
  if (value instanceof Uint8Array) {
    charge(state, 64 + 64 * value.length)
    const numbers: Value[] = []
    for (const byte of value) {
      state.signal?.throwIfAborted()
      numbers.push(byte)
    }
    return { value: numbers }
  }
  return detached(value, state, '', [], 1)
}
/** Bounded projection for ONE captured packed row. Native binary uses
 * 3,072-byte base64 windows; no complete number[] expansion is constructed.
 * Exact legacy optional-object omissions are retained without mutating source.
 * This does not establish coherent capture, table ordering or relational closure. */
export function projectBrc38PackedRow(
  kind: Kind,
  row: unknown,
  options: Brc38PackedRowOptions
): BRC38Tables[Kind & keyof BRC38Tables][number] {
  const maximum = options.maximumAllocationBytes
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16777216)
    throw new RangeError('maximumAllocationBytes must be an integer from 1 to 16777216')
  if (row === null || typeof row !== 'object' || Array.isArray(row)) invalid()
  plain(row)
  const state: State = { remaining: maximum, active: new Set([row]), signal: options.signal }
  charge(state, 64)
  const result: { [key: string]: Value } = Object.create(null)
  for (const key in row) {
    if (!Object.hasOwn(row, key)) continue
    if (key === 'logger' || (kind === 'certificates' && key === 'fields')) continue
    text(key, state)
    const value = data(row, key)
    if (value == null) continue
    result[key] = fieldValue(kind, key, value, state).value
  }
  return result
}
