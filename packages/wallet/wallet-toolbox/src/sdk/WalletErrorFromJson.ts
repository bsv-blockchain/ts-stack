import { WalletError } from './WalletError'
import {
  WERR_BAD_REQUEST,
  WERR_BROADCAST_UNAVAILABLE,
  WERR_INSUFFICIENT_FUNDS,
  WERR_INTERNAL,
  WERR_INVALID_OPERATION,
  WERR_INVALID_PARAMETER,
  WERR_INVALID_PUBLIC_KEY,
  WERR_MISSING_PARAMETER,
  WERR_NETWORK_CHAIN,
  WERR_NOT_ACTIVE,
  WERR_NOT_IMPLEMENTED,
  WERR_REVIEW_ACTIONS,
  WERR_UNAUTHORIZED
} from './WERR_errors'

/**
 * Reconstruct the correct derived WalletError from a JSON object created by `WalletError.unknownToJson`.
 *
 * This function is implemented as a separate function instead of a WalletError class static
 * to avoid circular dependencies.
 *
 * @param json
 * @returns a WalletError derived error object, typically for re-throw.
 */
export function WalletErrorFromJson(json: object): WalletError {
  let e: WalletError
  const obj = json as any
  switch (obj.name) {
    case 'WERR_NOT_IMPLEMENTED':
      e = new WERR_NOT_IMPLEMENTED(obj.message)
      break
    case 'WERR_INTERNAL':
      e = new WERR_INTERNAL(obj.message)
      break
    case 'WERR_INVALID_OPERATION':
      e = new WERR_INVALID_OPERATION(obj.message)
      break
    case 'WERR_BROADCAST_UNAVAILABLE':
      e = new WERR_BROADCAST_UNAVAILABLE(obj.message)
      break
    case 'WERR_INVALID_PARAMETER':
      e = new WERR_INVALID_PARAMETER(obj.parameter)
      e.message = obj.message
      break
    case 'WERR_MISSING_PARAMETER':
      e = new WERR_MISSING_PARAMETER(obj.parameter)
      e.message = obj.message
      break
    case 'WERR_BAD_REQUEST':
      e = new WERR_BAD_REQUEST(obj.message)
      break
    case 'WERR_NETWORK_CHAIN':
      e = new WERR_NETWORK_CHAIN(obj.message)
      break
    case 'WERR_UNAUTHORIZED':
      e = new WERR_UNAUTHORIZED(obj.message)
      break
    case 'WERR_NOT_ACTIVE':
      e = new WERR_NOT_ACTIVE(obj.message)
      break
    case 'WERR_INSUFFICIENT_FUNDS':
      e = new WERR_INSUFFICIENT_FUNDS(obj.totalSatoshisNeeded, obj.moreSatoshisNeeded)
      break
    case 'WERR_INVALID_PUBLIC_KEY':
      e = new WERR_INVALID_PUBLIC_KEY(obj.key, 'mainnet')
      e.message = obj.message
      break
    case 'WERR_REVIEW_ACTIONS':
      e = new WERR_REVIEW_ACTIONS(obj.reviewActionResults, obj.sendWithResults, obj.txid, obj.tx, obj.noSendChange)
      break
    default:
      {
        e = new WalletError(obj.name || 'WERR_UNKNOWN', obj.message || '')
      }
      break
  }
  return e
}
