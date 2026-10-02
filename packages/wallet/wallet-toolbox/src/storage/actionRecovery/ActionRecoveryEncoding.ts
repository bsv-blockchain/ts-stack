import { ACTION_RECOVERY_RECORD_BYTES, requireValue } from './ActionRecoveryEncodingLimits'

export { ACTION_RECOVERY_RECORD_BYTES, requireValue } from './ActionRecoveryEncodingLimits'
export { actionRecoveryJSON } from './ActionRecoveryJSON'

/** Own binary data without Buffer's coercion of out-of-range values or array holes. */
export function encodeActionRecoveryBytes(value: unknown): string {
  requireValue((Array.isArray(value) || value instanceof Uint8Array) && value.length <= ACTION_RECOVERY_RECORD_BYTES)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  const owned = Buffer.alloc(value.length)
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    requireValue(field !== undefined && field.enumerable && 'value' in field)
    const byte: unknown = field.value
    requireValue(typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
    owned[index] = byte
  }
  return owned.toString('base64')
}
