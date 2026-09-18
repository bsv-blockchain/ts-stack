const MAX_DEPTH = 32

/**
 * Serializes a JSON value deterministically: object keys sorted by UTF-16 code unit, no
 * whitespace, integers only. This is the RFC 8785 subset BRC-178 query identifiers hash.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError('Canonical JSON nesting exceeds 32 levels')
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('Canonical JSON numbers must be safe integers')
      }
      return String(value === 0 ? 0 : value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      return Array.isArray(value) ? serializeArray(value, depth) : serializeObject(value, depth)
    default:
      throw new TypeError(`Canonical JSON cannot encode a ${typeof value}`)
  }
}

function serializeArray(items: unknown[], depth: number): string {
  const parts: string[] = []
  for (const item of items) {
    if (item === undefined) throw new TypeError('Canonical JSON arrays cannot contain undefined')
    parts.push(serialize(item, depth + 1))
  }
  return `[${parts.join(',')}]`
}

function serializeObject(value: object, depth: number): string {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON objects must be plain objects')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const parts: string[] = []
  for (const key of keys) {
    const item = record[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${serialize(item, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}
