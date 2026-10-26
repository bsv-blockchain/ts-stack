/** True for property names that can alter or impersonate ordinary object structure. */
export function isUnsafeRecordKey(key: unknown): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
