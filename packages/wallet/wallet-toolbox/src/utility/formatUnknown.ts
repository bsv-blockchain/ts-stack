function formatObjectForLog (value: object): string {
  try {
    return JSON.stringify(value) ?? '[unserializable object]'
  } catch {
    return '[unserializable object]'
  }
}

/**
 * Produces a bounded-kind diagnostic representation without falling back to
 * JavaScript's unhelpful default object stringification.
 */
export function formatUnknownForLog (value: unknown): string {
  if (value == null) return ''
  if (value instanceof Error) return value.stack ?? value.message
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }

  if (typeof value === 'string') return value
  if (typeof value === 'number') return value.toString(10)
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'symbol') return value.description ?? ''
  if (typeof value === 'function') {
    return value.name === '' ? '[function]' : `[function ${value.name}]`
  }
  return formatObjectForLog(value)
}
