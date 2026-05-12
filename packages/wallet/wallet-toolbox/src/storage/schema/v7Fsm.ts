import * as sdk from '../../sdk'

/**
 * V7 processing-state machine.
 *
 * Maps each `ProcessingStatus` to the set of states it may legally transition
 * to. Terminal states (`proven`, `invalid`, `doubleSpend`) have no outgoing
 * transitions except via the `unfail` operator override.
 *
 * The transition table is intentionally permissive — the goal is to *reject
 * impossible* moves (e.g. `queued -> proven` without ever broadcasting) rather
 * than to enumerate the happy path. Stateful preconditions (proof present,
 * provider acknowledged) are enforced at the call site.
 */
const TRANSITIONS: Record<sdk.ProcessingStatus, sdk.ProcessingStatus[]> = {
  // `queued -> doubleSpend`: a tx queued locally may be reported as a
  // double-spend by the network before our first send attempt (e.g. another
  // wallet broadcast the same outpoint first). See V7_STORAGE_METHOD_WIRING §4
  // legacy mapping `* -> doubleSpend (rejection)`.
  queued: ['sending', 'sent', 'nosend', 'frozen', 'nonfinal', 'invalid', 'doubleSpend'],
  sending: ['sent', 'seen', 'seen_multi', 'invalid', 'doubleSpend', 'frozen', 'queued'],
  sent: ['seen', 'seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend', 'frozen', 'sending'],
  // `seen -> sending`: provider re-acknowledgment lost; legacy mapping
  // `* -> sending (serviceError retry)` from V7_STORAGE_METHOD_WIRING §4.
  seen: ['seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend', 'reorging', 'frozen', 'sending'],
  // `seen_multi -> sending`: same retry semantics as `seen -> sending`.
  seen_multi: ['unconfirmed', 'proven', 'invalid', 'doubleSpend', 'reorging', 'frozen', 'sending'],
  // `unconfirmed -> doubleSpend`: a provider's proof candidate may be retracted
  // when a competing tx is mined. `unconfirmed -> sending`: candidate failed
  // chaintracks validation, restart broadcast attempts. Both per §4.
  unconfirmed: ['proven', 'invalid', 'reorging', 'frozen', 'seen', 'seen_multi', 'doubleSpend', 'sending'],
  proven: ['reorging'],
  reorging: ['proven', 'seen', 'seen_multi', 'unconfirmed', 'invalid', 'doubleSpend', 'frozen'],
  invalid: ['unfail'],
  doubleSpend: ['unfail'],
  unfail: ['queued', 'sending', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend'],
  frozen: ['queued', 'sending', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'invalid', 'doubleSpend'],
  // `nosend -> sending`: operator (or processAction promotion) moves a
  // never-broadcast tx into the active broadcast pipeline. `nosend ->
  // doubleSpend`: an externally-broadcast nosend tx may be reported as a
  // double-spend. Both per §4 legacy mapping.
  nosend: ['queued', 'sending', 'sent', 'seen', 'invalid', 'doubleSpend', 'frozen'],
  // `nonfinal -> doubleSpend`: a live-nLockTime tx may be replaced by a
  // confirmed competing tx and reported as a double-spend.
  nonfinal: ['queued', 'sending', 'sent', 'invalid', 'doubleSpend', 'frozen']
}

export interface FsmTransitionResult {
  ok: boolean
  reason?: string
}

/**
 * Returns true when `from -> to` is a permitted V7 processing transition.
 * Identity transitions (`from === to`) are always allowed — they represent a
 * status refresh without state change.
 */
export function isValidProcessingTransition (
  from: sdk.ProcessingStatus,
  to: sdk.ProcessingStatus
): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/**
 * As `isValidProcessingTransition` but returns a structured result with a
 * human-readable reason for any rejection. Useful for `tx_audit` payloads.
 */
export function validateProcessingTransition (
  from: sdk.ProcessingStatus,
  to: sdk.ProcessingStatus
): FsmTransitionResult {
  if (isValidProcessingTransition(from, to)) return { ok: true }
  return {
    ok: false,
    reason: `illegal transition ${from} -> ${to}; legal next: ${TRANSITIONS[from].join(', ')}`
  }
}

/** Snapshot of the transition table for documentation + tests. */
export function processingTransitionMap (): Readonly<Record<sdk.ProcessingStatus, readonly sdk.ProcessingStatus[]>> {
  return TRANSITIONS
}

/**
 * True when the given state implies the transaction has been seen / accepted
 * by at least one network provider — the precondition for output spendability
 * in §4.
 */
export function isProcessingSpendable (s: sdk.ProcessingStatus): boolean {
  return sdk.ProcessingSpendableStatus.includes(s)
}

/** True when the state is terminal (no further automatic transitions). */
export function isProcessingTerminal (s: sdk.ProcessingStatus): boolean {
  return sdk.ProcessingTerminalStatus.includes(s)
}
