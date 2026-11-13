/** Receiver-owned protocol decoding. Keep published SDK2 consumers independent
 * of the SDK3 client's optional payment helpers. Raw-byte ownership, transport
 * quotas and authentication are enforced before this decoder is called. */
export function decodePaymentUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Decode an authenticated application payload while retaining its separately owned raw bytes. */
export function decodePaymentPayload(
  body: Uint8Array | undefined,
  contentType: string | undefined
): unknown {
  if (body === undefined) return undefined
  const mediaType = contentType?.split(';')[0].trim().toLowerCase()
  if (mediaType === 'application/json' || mediaType?.endsWith('+json') === true)
    return JSON.parse(decodePaymentUtf8(body)) as unknown
  if (mediaType?.startsWith('text/') === true) return decodePaymentUtf8(body)
  if (mediaType === 'application/x-www-form-urlencoded') {
    const values = new Map<string, string | string[]>()
    for (const [key, value] of new URLSearchParams(decodePaymentUtf8(body))) {
      const prior = values.get(key)
      if (prior === undefined) values.set(key, value)
      else if (Array.isArray(prior)) prior.push(value)
      else values.set(key, [prior, value])
    }
    // Remote names remain Map keys until the complete data record is built.
    // fromEntries creates own data properties, including __proto__; remove its
    // prototype before publishing the same null-prototype application payload.
    return Object.setPrototypeOf(Object.fromEntries(values), null)
  }
  return body
}

export type PaymentTransportErrorCode =
  | 'ERR_PAYMENT_SIZE'
  | 'ERR_PAYMENT_TRANSPORT'
  | 'ERR_PAYMENT_REQUIREMENTS_CHANGED'
  | 'ERR_PAYMENT_OUTCOME_UNKNOWN'
  | 'ERR_PAYMENT_CANCELLED'

/** Permanent transport refusals are not retried automatically. No payment bytes are attached. */
export class PaymentTransportError extends Error {
  readonly retryable = false
  constructor(
    readonly code: PaymentTransportErrorCode,
    message: string,
    readonly payment?: {
      txid: string
      state: 'prepared' | 'submitted' | 'uncertain'
      aborted?: boolean
    },
    readonly httpStatus?: number,
    readonly authenticated?: boolean
  ) {
    super(message)
    this.name = 'PaymentTransportError'
  }
}

export function isMultipartPaymentType(value: string): boolean {
  return value.split(';')[0].trim().toLowerCase() === 'multipart/form-data'
}

export function paymentBoundary(contentType: string): string {
  // One unambiguous boundary parameter; quoted MIME token boundaries are accepted.
  const match =
    /^multipart\/form-data\s*;\s*boundary=(?:([a-z0-9'()+_,./:=?-]{1,70})|"([a-z0-9'()+_,./:=?-]{1,70})")\s*$/i.exec(
      contentType
    )
  if (match == null)
    throw new PaymentTransportError('ERR_PAYMENT_TRANSPORT', 'Invalid multipart payment boundary.')
  return match[1] ?? match[2]
}

export function paymentPayloadContentType(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    /[^\x20-\x7e]/.test(value) ||
    !/^[!#$%&'*+.^`|~\w-]+\/[!#$%&'*+.^`|~\w-]+(?:\s*;.*)?$/.test(value)
  ) {
    throw new PaymentTransportError(
      'ERR_PAYMENT_TRANSPORT',
      'Invalid original payload Content-Type.'
    )
  }
  return value
}
