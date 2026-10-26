import { ACTION_RECOVERY_RECORD_BYTES, requireValue } from './ActionRecoveryEncodingLimits'
import { ActionRecoveryJSONOwnership } from './ActionRecoveryJSONOwnership'

/** Owned, accessor-free local JSON, with fixed resource bounds and deterministic keys. */
export function actionRecoveryJSON(value: unknown): string {
  const json = JSON.stringify(new ActionRecoveryJSONOwnership().copy(value, 0))
  requireValue(Buffer.byteLength(json, 'utf8') <= ACTION_RECOVERY_RECORD_BYTES)
  return json
}
