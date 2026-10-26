import { ACTION_RECOVERY_RECORD_BYTES, requireValue } from './ActionRecoveryEncodingLimits'

const maximumItems = 2048
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

/** Internal call-local ownership; no retained authority or format changes. */
export class ActionRecoveryJSONOwnership {
  private items = 0
  private characters = 0
  private readonly active = new Set<object>()

  copy(input: unknown, depth: number): JSONValue {
    requireValue(depth <= 16 && ++this.items <= 65536)
    let value: JSONValue
    if (input === null || typeof input === 'boolean') value = input
    else if (typeof input === 'number') {
      requireValue(Number.isSafeInteger(input))
      value = input
    } else if (typeof input === 'string') {
      this.characters += input.length
      requireValue(
        Buffer.from(input, 'utf8').toString('utf8') === input && this.characters <= ACTION_RECOVERY_RECORD_BYTES
      )
      value = input
    } else {
      requireValue(typeof input === 'object' && !this.active.has(input))
      this.active.add(input)
      try {
        const keys = Reflect.ownKeys(input)
        value = Array.isArray(input) ? this.array(input, keys, depth) : this.object(input, keys, depth)
      } finally {
        this.active.delete(input)
      }
    }
    return value
  }

  private array(input: unknown[], keys: (string | symbol)[], depth: number): JSONValue[] {
    requireValue(input.length <= maximumItems && keys.length === input.length + 1)
    return Array.from({ length: input.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(input, String(index))
      requireValue(property !== undefined && property.enumerable && 'value' in property)
      return this.copy(property.value, depth + 1)
    })
  }

  private object(input: object, keys: (string | symbol)[], depth: number): { [key: string]: JSONValue } {
    requireValue(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
    requireValue(keys.length <= maximumItems && keys.every(key => typeof key === 'string'))
    const fields = new Map<string, JSONValue>()
    // Preserve the stored format's UTF-16 code-unit order, independent of locale.
    for (const key of (keys as string[]).sort((left, right) => Number(left > right) - Number(left < right))) {
      this.copy(key, depth + 1)
      const property = Object.getOwnPropertyDescriptor(input, key)!
      requireValue(property.enumerable && 'value' in property)
      if (property.value !== undefined) fields.set(key, this.copy(property.value, depth + 1))
    }
    return Object.fromEntries(fields)
  }
}
