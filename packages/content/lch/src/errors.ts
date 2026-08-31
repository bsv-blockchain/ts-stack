export type LCHErrorCode =
  | 'ERR_LCH_FRAMING'
  | 'ERR_LCH_CBOR'
  | 'ERR_LCH_SIGNATURE'
  | 'ERR_LCH_AUTHORITY'
  | 'ERR_LCH_REVOCATION'
  | 'ERR_LCH_ENDPOINT'
  | 'ERR_LCH_PROFILE_UNSUPPORTED'
  | 'ERR_LCH_POLICY'
  | 'ERR_LCH_TERMS'
  | 'ERR_LCH_CONTENT_UNAVAILABLE'
  | 'ERR_LCH_CONTENT_DIGEST'
  | 'ERR_LCH_KEY'
  | 'ERR_LCH_AUTHENTICATION'
  | 'ERR_LCH_SELECTION'
  | 'ERR_LCH_QUOTE'
  | 'ERR_LCH_PAYMENT'
  | 'ERR_LCH_DELIVERY'
  | 'ERR_LCH_LICENSE'
  | 'ERR_LCH_PROVENANCE'
  | 'ERR_LCH_CYCLE'

export class LCHError extends Error {
  constructor(
    public readonly code: LCHErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'LCHError'
  }
}

export function lchAssert(
  condition: unknown,
  code: LCHErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new LCHError(code, message)
}
