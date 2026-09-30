import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const ACTION_RECOVERY_RECORD_BYTES = 16 * 1024 * 1024
const maximumItems = 2048
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

export function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION('Invalid or oversized action recovery record')
}

/** Owned, accessor-free local JSON, with fixed resource bounds and deterministic keys. */
export function actionRecoveryJSON(value: unknown): string {
  let items = 0, characters = 0
  const active = new Set<object>()
  function own(input: unknown, depth: number): JSONValue {
    requireValue(depth <= 16 && ++items <= 65536)
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      requireValue(Number.isSafeInteger(input))
      return input
    }
    if (typeof input === 'string') {
      characters += input.length
      requireValue(Buffer.from(input, 'utf8').toString('utf8') === input && characters <= ACTION_RECOVERY_RECORD_BYTES)
      return input
    }
    requireValue(typeof input === 'object' && input !== null && !active.has(input))
    active.add(input)
    try {
      const keys = Reflect.ownKeys(input)
      if (Array.isArray(input)) {
        requireValue(input.length <= maximumItems && keys.length === input.length + 1)
        return Array.from({ length: input.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(input, String(index))
          requireValue(property !== undefined && property.enumerable && 'value' in property)
          return own(property.value, depth + 1)
        })
      }
      requireValue(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
      requireValue(keys.length <= maximumItems && keys.every(key => typeof key === 'string'))
      const fields = new Map<string, JSONValue>()
      // Preserve the stored format's UTF-16 code-unit order, independent of locale.
      for (const key of (keys as string[]).sort((left, right) => Number(left > right) - Number(left < right))) {
        own(key, depth + 1)
        const property = Object.getOwnPropertyDescriptor(input, key)!
        requireValue(property.enumerable && 'value' in property)
        if (property.value !== undefined) fields.set(key, own(property.value, depth + 1))
      }
      return Object.fromEntries(fields)
    } finally {
      active.delete(input)
    }
  }
  const json = JSON.stringify(own(value, 0))
  requireValue(Buffer.byteLength(json, 'utf8') <= ACTION_RECOVERY_RECORD_BYTES)
  return json
}


/** Own binary data without Buffer's coercion of out-of-range values or array holes. */
export function encodeActionRecoveryBytes(value: unknown): string {
  requireValue((Array.isArray(value) || value instanceof Uint8Array) && value.length <= ACTION_RECOVERY_RECORD_BYTES)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  const owned = Buffer.alloc(value.length)
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    requireValue(field !== undefined && field.enumerable && 'value' in field)
    const byte: unknown = field.value
    requireValue(typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
    owned[index] = byte
  }
  return owned.toString('base64')
}
