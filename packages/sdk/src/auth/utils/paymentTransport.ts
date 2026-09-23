import Random from '../../primitives/Random.js'
import { toArray, toHex } from '../../primitives/utils.js'

export interface PaymentTransportLimits {
  /** Selection threshold, not a guarantee about a particular proxy. Default 8 KiB. */
  maxPaymentHeaderBytes?: number
  /** Includes a 4 KiB reserve for authentication and HTTP framing. Default 16 KiB. */
  maxRequestHeaderBytes?: number
  /** Maximum serialized payment JSON. Default 4 MiB. */
  maxPaymentBytes?: number
  /** Complete transmitted request body, including multipart framing. Default 7 MiB. */
  maxBodyBytes?: number
}

export interface ResolvedPaymentTransportLimits {
  maxPaymentHeaderBytes: number
  maxRequestHeaderBytes: number
  maxPaymentBytes: number
  maxBodyBytes: number
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

export function resolvePaymentTransportLimits(
  options: PaymentTransportLimits = {}
): ResolvedPaymentTransportLimits {
  const limits = {
    maxPaymentHeaderBytes: options.maxPaymentHeaderBytes ?? 8192,
    maxRequestHeaderBytes: options.maxRequestHeaderBytes ?? 16 * 1024,
    maxPaymentBytes: options.maxPaymentBytes ?? 4 * 1024 * 1024,
    maxBodyBytes: options.maxBodyBytes ?? 7 * 1024 * 1024
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
      throw new RangeError(`${key} must be an integer from 1 through 16777216`)
    }
  }
  // The released authenticated transport has a fixed per-header ceiling.
  if (limits.maxPaymentHeaderBytes > 8192)
    throw new RangeError('maxPaymentHeaderBytes cannot exceed 8192')
  return limits
}

export function paymentTransports(advertisement: string | null): ReadonlySet<string> {
  if (advertisement === null) return new Set(['header'])
  if (advertisement.length > 256)
    throw new PaymentTransportError(
      'ERR_PAYMENT_TRANSPORT',
      'Payment transport advertisement is too large.'
    )
  return new Set(
    advertisement
      .split(',')
      .map(value => value.trim())
      .filter(value => value === 'header' || value === 'multipart')
  )
}

/** Keep released non-multipart preimages; bind the exact multipart boundary and parameters. */
export function authenticatedContentType(value: string): string {
  return isMultipartPaymentType(value) ? value : value.split(';')[0].trim()
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

/** Linear-time byte search, also used to rule out delimiter collisions before signing. */
export function findPaymentBytes(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  const prefix = new Uint32Array(needle.length)
  for (let index = 1, length = 0; index < needle.length;) {
    if (needle[index] === needle[length]) prefix[index++] = ++length
    else if (length > 0) length = prefix[length - 1]
    else prefix[index++] = 0
  }
  for (let index = from, length = 0; index < bytes.length;) {
    if (bytes[index] === needle[length]) {
      index++
      if (++length === needle.length) return index - length
    } else if (length > 0) length = prefix[length - 1]
    else index++
  }
  return -1
}

export interface MultipartPaymentBody {
  contentType: string
  body: Uint8Array
}

function paymentRequestHeaders(originalHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  for (const [name, value] of Object.entries(originalHeaders)) {
    const lower = name.toLowerCase()
    if (Object.hasOwn(headers, lower))
      throw new PaymentTransportError('ERR_PAYMENT_TRANSPORT', 'Duplicate request header.')
    if (lower !== 'x-bsv-payment') headers[lower] = value
  }
  return headers
}

export function preparePaymentTransport(
  paymentJSON: string,
  original: { method: string; headers: Record<string, string>; body?: Uint8Array },
  transports: ReadonlySet<string>,
  limits: ResolvedPaymentTransportLimits
): { headers: Record<string, string>; body?: Uint8Array; transport: 'header' | 'multipart' } {
  const paymentSize = toArray(paymentJSON, 'utf8').length
  if (paymentSize > limits.maxPaymentBytes)
    throw new PaymentTransportError(
      'ERR_PAYMENT_SIZE',
      'Payment JSON exceeds its configured limit.'
    )
  const headers = paymentRequestHeaders(original.headers)
  const originalType = headers['content-type']
  let body = original.body
  let transport: 'header' | 'multipart' = 'header'
  if (
    paymentSize > limits.maxPaymentHeaderBytes ||
    !transports.has('header') ||
    (originalType !== undefined && isMultipartPaymentType(originalType))
  ) {
    if (!transports.has('multipart'))
      throw new PaymentTransportError(
        'ERR_PAYMENT_TRANSPORT',
        'This payment requires multipart support from the authenticated server.'
      )
    if (['GET', 'HEAD'].includes(original.method.toUpperCase()))
      throw new PaymentTransportError(
        'ERR_PAYMENT_TRANSPORT',
        'Fetch cannot carry a multipart payment with GET or HEAD; use a server-supported body-bearing route.'
      )
    const multipart = buildMultipartPayment(
      paymentJSON,
      body === undefined
        ? undefined
        : { bytes: body, contentType: originalType ?? 'application/octet-stream' },
      limits.maxBodyBytes
    )
    headers['content-type'] = multipart.contentType
    body = multipart.body
    transport = 'multipart'
  } else headers['x-bsv-payment'] = paymentJSON
  if (body !== undefined && body.length > limits.maxBodyBytes)
    throw new PaymentTransportError('ERR_PAYMENT_SIZE', 'Paid request exceeds the body limit.')
  const headerBytes = Object.entries(headers).reduce(
    (total, [name, value]) =>
      total + toArray(name, 'utf8').length + toArray(value, 'utf8').length + 4,
    4096
  )
  if (headerBytes > limits.maxRequestHeaderBytes)
    throw new PaymentTransportError(
      'ERR_PAYMENT_SIZE',
      'Paid request exceeds the aggregate header budget.'
    )
  return { headers, body, transport }
}

/** Serialize once, then sign and transmit these same owned bytes. Never pass native FormData. */
export function buildMultipartPayment(
  paymentJSON: string,
  payload: { bytes: Uint8Array; contentType: string } | undefined,
  maximumBytes: number,
  boundary = `----BsvPayment${toHex(Random(16))}`
): MultipartPaymentBody {
  const contentType = `multipart/form-data; boundary=${boundary}`
  paymentBoundary(contentType)
  const utf8 = (text: string): Uint8Array => new Uint8Array(toArray(text, 'utf8'))
  const payment = utf8(paymentJSON)
  const delimiter = utf8(`--${boundary}`)
  if (
    findPaymentBytes(payment, delimiter) !== -1 ||
    (payload !== undefined && findPaymentBytes(payload.bytes, delimiter) !== -1)
  ) {
    throw new PaymentTransportError(
      'ERR_PAYMENT_TRANSPORT',
      'Multipart boundary collides with payload.'
    )
  }
  const pieces = [
    utf8(
      `--${boundary}\r\nContent-Disposition: form-data; name="x-bsv-payment"\r\nContent-Type: application/json\r\n\r\n`
    ),
    payment
  ]
  if (payload !== undefined) {
    pieces.push(
      utf8(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="body"\r\nContent-Type: ${paymentPayloadContentType(payload.contentType)}\r\n\r\n`
      ),
      payload.bytes
    )
  }
  pieces.push(utf8(`\r\n--${boundary}--\r\n`))
  const length = pieces.reduce((total, piece) => total + piece.length, 0)
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || length > maximumBytes) {
    throw new PaymentTransportError(
      'ERR_PAYMENT_SIZE',
      'Multipart payment exceeds the request body limit.'
    )
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const piece of pieces) {
    body.set(piece, offset)
    offset += piece.length
  }
  return { contentType, body }
}
