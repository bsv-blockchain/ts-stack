import { normalizeBRC100ByteArray } from '@bsv/sdk'

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255
}

function snapshotArray(value: unknown[], name: string, maximumLength: number): number[] {
  const keys = Reflect.ownKeys(value)
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    keys.length !== value.length + 1
  ) {
    throw new TypeError(`${name} must be a bounded dense byte array.`)
  }
  const snapshot = Array.from<number>({ length: value.length })
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      descriptor.enumerable !== true ||
      !('value' in descriptor) ||
      !isByte(descriptor.value)
    ) {
      throw new TypeError(`${name} must be a bounded dense byte array.`)
    }
    snapshot[index] = descriptor.value
  }
  return snapshot
}

function snapshotHistoricalRecord(value: object, name: string, maximumLength: number): number[] {
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length === 0 ||
    keys.length > maximumLength
  ) {
    throw new TypeError(`${name} must be a bounded dense byte array.`)
  }
  const snapshot = Array.from<number>({ length: keys.length })
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      key !== String(index) ||
      descriptor == null ||
      descriptor.enumerable !== true ||
      !('value' in descriptor) ||
      !isByte(descriptor.value)
    ) {
      throw new TypeError(`${name} must be a bounded dense byte array.`)
    }
    snapshot[index] = descriptor.value
  }
  return snapshot
}

/** Snapshot a supported BRC-100 byte representation exactly once without invoking accessors. */
export function snapshotDenseByteArray(
  value: unknown,
  name: string,
  maximumLength: number
): number[] {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 0) {
    throw new TypeError('Byte-array maximum length is invalid.')
  }
  try {
    if (Array.isArray(value)) return snapshotArray(value, name, maximumLength)
    if (
      value != null &&
      typeof value === 'object' &&
      typeof ArrayBuffer !== 'undefined' &&
      ArrayBuffer.isView(value)
    ) {
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw new TypeError(`${name} must be a bounded dense byte array.`)
      }
      const normalized = normalizeBRC100ByteArray(value)
      if (normalized == null || Array.isArray(normalized) || normalized.length > maximumLength) {
        throw new TypeError(`${name} must be a bounded dense byte array.`)
      }
      const owned = Uint8Array.prototype.slice.call(normalized)
      return Array.from(owned)
    }
    if (value != null && typeof value === 'object') {
      return snapshotHistoricalRecord(value, name, maximumLength)
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error
  }
  throw new TypeError(`${name} must be a bounded dense byte array.`)
}
