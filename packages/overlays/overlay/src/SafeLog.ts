const UNSERIALIZABLE_LOG_VALUE = '"[Unserializable value]"'

/**
 * Serializes an untrusted value as a single JSON log field.
 *
 * JSON escaping prevents carriage returns, line feeds, and other control
 * characters from forging additional log records. JavaScript permits the
 * C1 controls and Unicode line/paragraph separators in JSON strings, so those
 * characters are escaped explicitly as well.
 */
export function serializeLogValue (value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      return UNSERIALIZABLE_LOG_VALUE
    }
    return serialized.replace(
      /[\u0080-\u009f\u2028\u2029]/g,
      character => String.raw`\u${(character.codePointAt(0) as number).toString(16).padStart(4, '0')}`
    )
  } catch {
    return UNSERIALIZABLE_LOG_VALUE
  }
}

/**
 * Serializes an unknown thrown value without allowing it to inject log lines.
 */
export function serializeErrorForLog (error: unknown): string {
  if (!(error instanceof Error)) {
    return serializeLogValue(error)
  }

  try {
    return serializeLogValue({
      name: error.name,
      message: error.message,
      stack: error.stack
    })
  } catch {
    return UNSERIALIZABLE_LOG_VALUE
  }
}
