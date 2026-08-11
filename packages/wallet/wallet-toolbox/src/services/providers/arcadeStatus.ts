import { isArcDoubleSpendTxStatus, isArcInvalidTxStatus } from './ARC'

export interface ArcadeLifecycleStatus {
  txStatus: string
  status?: number
  extraInfo?: string
}

export interface ArcadeRejectionClassification {
  terminal: boolean
  inputConflict: boolean
  reqStatus: 'invalid' | 'doubleSpend'
  reason: string
}

/**
 * Canonical classification shared by Arcade polling and SSE. Keeping this in
 * one place prevents a provider from calling a rejection "unknown" while the
 * monitor's event path calls the same status terminal.
 */
export function classifyArcadeRejection(event: ArcadeLifecycleStatus): ArcadeRejectionClassification {
  const extraInfo = event.extraInfo?.trim() ?? ''
  const detail = extraInfo.toLowerCase()
  const retryable =
    event.status === 476 ||
    detail.startsWith('parent rejected') ||
    detail.includes('not final') ||
    detail.includes('non-final')
  if (retryable) {
    return {
      terminal: false,
      inputConflict: false,
      reqStatus: 'invalid',
      reason:
        event.status === 476 ? 'transaction is not final' : 'Arcade reported a retryable parent/locktime condition'
    }
  }

  const orphanConflict = isArcDoubleSpendTxStatus(event.txStatus)
  const inputConflict =
    orphanConflict ||
    event.status === 462 ||
    event.status === 466 ||
    /(?:utxo|input).*(?:spent|missing|conflict)|missing[- ]inputs?|already spent/.test(detail)
  const classifiedValidatorFailure = event.status != null && event.status >= 460 && event.status <= 475
  const explicitInvalidStatus = isArcInvalidTxStatus(event.txStatus) && event.txStatus !== 'REJECTED'
  const terminal = inputConflict || classifiedValidatorFailure || explicitInvalidStatus || extraInfo !== ''
  let reason = 'Arcade supplied no durable rejection evidence'
  if (orphanConflict) {
    reason = `Arcade reported ${event.txStatus}`
  } else if (inputConflict) {
    reason = 'Arcade supplied confirmed missing-input/conflict evidence'
  } else if (classifiedValidatorFailure) {
    reason = `Arcade supplied terminal validator code ${String(event.status)}`
  } else if (explicitInvalidStatus) {
    reason = `Arcade reported terminal ${event.txStatus}`
  } else if (extraInfo !== '') {
    reason = 'Arcade supplied a terminal validator rejection reason'
  }
  return {
    terminal,
    inputConflict,
    reqStatus: inputConflict ? 'doubleSpend' : 'invalid',
    reason
  }
}
