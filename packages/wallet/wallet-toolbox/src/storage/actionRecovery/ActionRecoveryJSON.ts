import { ACTION_RECOVERY_RECORD_BYTES, requireValue } from './ActionRecoveryEncodingLimits'

const maximumItems = 2048
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

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
