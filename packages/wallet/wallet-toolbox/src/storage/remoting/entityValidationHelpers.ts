import { EntityTimeStamp } from '../../sdk/types'

/**
 * Shared entity-validation helpers used by both client-side storage remoting
 * (StorageClientBase / StorageMobile) and the server-side StorageServer.
 *
 * These helpers normalise records returned from remote calls or database queries:
 *   - Coerce date strings / timestamps to `Date` objects.
 *   - Replace `null` values with `undefined`.
 *   - Replace `Uint8Array` / `Buffer` values with plain `number[]` arrays.
 */

export function validateDate (date: Date | string | number): Date {
  if (date instanceof Date) return date
  return new Date(date)
}

/**
 * Force uniform behaviour across database engines.
 * Use to process all individual records with timestamps retrieved from database.
 */
export function validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T {
  entity.created_at = validateDate(entity.created_at)
  entity.updated_at = validateDate(entity.updated_at)
  if (dateFields != null) {
    for (const df of dateFields) {
      if (entity[df]) entity[df] = validateDate(entity[df])
    }
  }
  for (const key of Object.keys(entity)) {
    const val = entity[key]
    if (val === null) {
      entity[key] = undefined
    } else if (val instanceof Uint8Array) {
      entity[key] = Array.from(val)
    }
  }
  return entity
}

/**
 * Force uniform behaviour across database engines.
 * Use to process all arrays of records with timestamps retrieved from database.
 * @returns input `entities` array with contained values validated.
 */
export function validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[] {
  for (let i = 0; i < entities.length; i++) {
    entities[i] = validateEntity(entities[i], dateFields)
  }
  return entities
}
