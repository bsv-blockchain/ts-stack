function ownDataValue(value: object, property: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  const ownValue =
    descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
  return ownValue?.value
}

/**
 * Normalize the insert identifiers returned by the supported Knex drivers.
 * Database results still cross a trust boundary: inherited values and accessors
 * must not select a different row or execute application code.
 */
export function insertedIdFromResult(insertResult: unknown): number | undefined {
  const candidate = Array.isArray(insertResult) ? ownDataValue(insertResult, '0') : insertResult
  const id =
    typeof candidate === 'number'
      ? candidate
      : candidate != null && typeof candidate === 'object'
        ? ownDataValue(candidate, 'id')
        : undefined
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined
}
