export type EQCErrorCode =
  | 'ERR_EQC_NO_HOSTS'
  | 'ERR_EQC_BUDGET'
  | 'ERR_EQC_NO_ATTESTATION'
  | 'ERR_EQC_THRESHOLD'
  | 'ERR_EQC_PAYMENT'
  | 'ERR_EQC_UNDELIVERED'

/** Thrown by the client when a query cannot complete. `details` carries diagnostics. */
export class EQCError extends Error {
  readonly code: EQCErrorCode
  readonly details: Record<string, unknown>

  constructor(code: EQCErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EQCError'
    this.code = code
    this.details = details
  }
}

export type HostErrorCode =
  | 'ERR_INVALID_QUERY'
  | 'ERR_INVALID_COLLECT'
  | 'ERR_AUTH_REQUIRED'
  | 'ERR_PAYMENT_REQUIRED'
  | 'ERR_FORBIDDEN_RECIPIENT'
  | 'ERR_QUERY_UNKNOWN'
  | 'ERR_QUERY_SETTLED'
  | 'ERR_HASH_MISMATCH'
  | 'ERR_NOT_RANKED'
  | 'ERR_QUERY_EXPIRED'
  | 'ERR_PAYLOAD_TOO_LARGE'
  | 'ERR_UNSUPPORTED_CLASS'
  | 'ERR_TOO_MANY_PENDING'
  | 'ERR_INTERNAL'

/** Thrown inside host handlers and providers; mapped to `{ status: 'error', code, description }`. */
export class HostError extends Error {
  readonly status: number
  readonly code: HostErrorCode
  readonly headers: Record<string, string>

  constructor(
    status: number,
    code: HostErrorCode,
    description: string,
    headers: Record<string, string> = {}
  ) {
    super(description)
    this.name = 'HostError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}
