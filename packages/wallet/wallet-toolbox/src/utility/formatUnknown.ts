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

  switch (typeof value) {
    case 'string':
      return value
    case 'number':
      return value.toString(10)
    case 'bigint':
      return value.toString(10)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'symbol':
      return value.description ?? ''
    case 'function':
      return value.name === '' ? '[function]' : `[function ${value.name}]`
    case 'object':
      return formatObjectForLog(value)
    default:
      return '[unserializable value]'
  }
}
