import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const ACTION_RECOVERY_RECORD_BYTES = 16 * 1024 * 1024
export function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION('Invalid or oversized action recovery record')
}
