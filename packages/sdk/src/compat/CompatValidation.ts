export const MAX_COMPAT_BYTE_PAYLOAD = 16 * 1024 * 1024

/** Copy a legacy byte-array argument without permitting sparse or coercible values. */
export function compatBytes(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = MAX_COMPAT_BYTE_PAYLOAD
): number[] {
  if (
    (!Array.isArray(value) && !(value instanceof Uint8Array)) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded dense byte array`)
  }
  if (value instanceof Uint8Array) return Array.from(value)
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new TypeError(`${label} must be a bounded dense byte array`)
    }
    copy[index] = descriptor.value
  }
  return copy
}

export function compatString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded string`)
  }
  return value
}

export function uint32(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new TypeError(`${label} must be a uint32`)
  }
  return value
}
