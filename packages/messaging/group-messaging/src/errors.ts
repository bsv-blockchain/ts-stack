import type { IdentityKey } from './types.js'

export class GroupMessagingError extends Error {
  override name = 'GroupMessagingError'
}

export class NotImplementedError extends GroupMessagingError {
  override name = 'NotImplementedError'
  constructor(what: string) {
    super(`${what} is not implemented yet`)
  }
}

export class UnknownGroupError extends GroupMessagingError {
  override name = 'UnknownGroupError'
  constructor(groupId: string) {
    super(`No local state for group ${groupId}`)
  }
}

/** A credential failed to bind its MLS signature key to a BRC-100 identity. */
export class CredentialBindingError extends GroupMessagingError {
  override name = 'CredentialBindingError'
}

/** A message arrived for an epoch this client has not reached yet. */
export class EpochMismatchError extends GroupMessagingError {
  override name = 'EpochMismatchError'
  constructor(
    readonly groupId: string,
    readonly expected: bigint,
    readonly received: bigint
  ) {
    super(`Group ${groupId} is at epoch ${expected}, message is for epoch ${received}`)
  }
}

/**
 * Raised at the transport seam when one or more handlers failed on a message.
 *
 * Thrown *after* every handler has run and every failure has been reported, so
 * a backend that can retry — MessageBox leaves the message in the box — learns
 * the message was not processed without any subscriber being skipped. Its
 * `failures` have already been reported individually; a backend that catches
 * one must not report it again.
 *
 * It lives here rather than beside `TransportService` so a backend can
 * recognize it without importing the service that raised it.
 */
export class DeliveryFailed extends GroupMessagingError {
  override name = 'DeliveryFailed'
  constructor(
    readonly from: IdentityKey,
    readonly failures: Error[]
  ) {
    super(
      `Delivery from ${from} failed in ${failures.length} handler(s): ` +
        failures.map(failure => failure.message).join('; ')
    )
  }
}

/**
 * A failure that no retry can fix.
 *
 * The transport's retry cap exists for transient trouble — a storage write that
 * failed, a wallet that was briefly locked. Some failures are settled the first
 * time: MLS discards a per-message key once it is used, so a replayed message is
 * unopenable for good, and no number of polls changes that. Retrying those costs
 * a poll each and ends in a "giving up" report that reads like a defect rather
 * than like the library refusing a duplicate.
 */
export class PermanentProcessingError extends GroupMessagingError {
  override name = 'PermanentProcessingError'
  readonly permanent = true
}

/**
 * Whether a thrown value asked not to be retried.
 *
 * Reads a `permanent` property rather than testing the class, so a host
 * wrapping our error, or a future error type, still participates. Duck-types
 * a {@link DeliveryFailed}-shaped aggregate the same way, on a non-empty
 * `failures` array: an aggregate is permanent only if every one of its
 * failures is — one transient failure among them means a retry might still
 * get that handler through.
 *
 * Every read is inside a `try`. This is called from inside a delivery loop
 * (`MessageBoxTransport#failed`), where a host's error class could define
 * `permanent` as a getter that throws; a predicate that propagated that
 * would abort the batch instead of just answering "not permanent" for one
 * message. Erring toward retryable is the safe direction: a needless retry
 * costs a poll, a wrongly-permanent verdict costs the message.
 */
export const isPermanent = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  try {
    if ((error as { permanent?: unknown }).permanent === true) return true
    const failures = (error as { failures?: unknown }).failures
    if (!Array.isArray(failures) || failures.length === 0) return false
    return failures.every(failure => isPermanent(failure))
  } catch {
    return false
  }
}
