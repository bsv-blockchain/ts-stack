/** Machine-readable reason carried by every {@link WebRTPayError}. */
export type WebRTPayErrorCode =
  | 'timeout'
  | 'closed'
  | 'protocol'
  | 'auth_failed'
  | 'peer_unreachable'
  | 'rejected'
  | 'invalid_code'
  | 'invalid_payment'
  | 'invalid_signal'
  | 'rate_limited'
  | 'too_large'
  | 'unsupported'
  /** A service it depends on (a relay's TURN provider) could not serve it just then. */
  | 'unavailable'

/**
 * The only error type this package throws or rejects with for expected failures
 * (hostile input, timeouts, closed peers). Callers branch on {@link code}.
 */
export class WebRTPayError extends Error {
  readonly code: WebRTPayErrorCode
  /**
   * Why the peer refused, on `rejected` errors from `DirectPayClient.connect`: `busy`,
   * `not_receiving` or `wrong_network` (the recipient's wallet is on another network), or
   * whatever else the peer said, at most 200 characters. Absent when the peer gave no
   * reason, and on other errors.
   */
  declare readonly reason?: string

  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable detail; defaults to the code.
   * @param options - `cause` is the underlying error, kept on `error.cause`; `reason` is
   * kept on `error.reason`.
   */
  constructor(
    code: WebRTPayErrorCode,
    message?: string,
    options?: { cause?: unknown; reason?: string }
  ) {
    super(message ?? code, options && 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'WebRTPayError'
    this.code = code
    if (options?.reason !== undefined) this.reason = options.reason
  }
}
