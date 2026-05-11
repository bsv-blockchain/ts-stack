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
  queued: ['sending', 'sent', 'nosend', 'frozen', 'nonfinal', 'invalid'],
  sending: ['sent', 'seen', 'seen_multi', 'invalid', 'doubleSpend', 'frozen', 'queued'],
  sent: ['seen', 'seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend', 'frozen', 'sending'],
  seen: ['seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend', 'reorging', 'frozen'],
  seen_multi: ['unconfirmed', 'proven', 'invalid', 'doubleSpend', 'reorging', 'frozen'],
  unconfirmed: ['proven', 'invalid', 'reorging', 'frozen', 'seen', 'seen_multi'],
  proven: ['reorging'],
  reorging: ['proven', 'seen', 'seen_multi', 'unconfirmed', 'invalid', 'doubleSpend', 'frozen'],
  invalid: ['unfail'],
  doubleSpend: ['unfail'],
  unfail: ['queued', 'sending', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'proven', 'invalid', 'doubleSpend'],
  frozen: ['queued', 'sending', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'invalid', 'doubleSpend'],
  nosend: ['queued', 'sent', 'seen', 'invalid', 'frozen'],
  nonfinal: ['queued', 'sending', 'sent', 'invalid', 'frozen']
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
