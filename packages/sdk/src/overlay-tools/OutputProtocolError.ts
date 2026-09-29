/** Failures shared by the opt-in BRC-192–199 protocols. */
export type OutputProtocolErrorCode =
  | 'invalid'
  | 'unsupported'
  | 'unauthorized'
  | 'not-found'
  | 'conflict'
  | 'equivocation'
  | 'limited'
  | 'unavailable'
  | 'expired'
  | 'reset-required'
  | 'revision-unavailable'
  | 'cancelled'
  | 'context-changed'

export class OutputProtocolError extends Error {
  constructor(
    readonly code: OutputProtocolErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'OutputProtocolError'
  }
}

export function outputAssert(
  condition: unknown,
  message: string,
  code: OutputProtocolErrorCode = 'invalid'
): asserts condition {
  if (!condition) throw new OutputProtocolError(code, message)
}
