import {
  paymentBoundary,
  paymentPayloadContentType,
  PaymentTransportError
} from '@bsv/sdk/auth/utils/paymentTransport'
import { toUTF8Strict } from '@bsv/sdk/primitives/utils'

export interface ParsedMultipartPayment {
  paymentJSON: string
  body?: Uint8Array
  contentType?: string
}

/** An ordinary, unpaid multipart application request needs the normal 402 challenge. */
export class MissingMultipartPayment extends Error {}

function malformed(): never {
  throw new PaymentTransportError('ERR_PAYMENT_TRANSPORT', 'Malformed multipart payment.')
}

interface Part {
  name: string
  contentType?: string
  bytes: Uint8Array
  next: number
  final: boolean
}

function partHeaders(
  source: Buffer,
  position: number
): { headers: Map<string, string>; start: number } {
  // Bound the header search itself, before reading any attacker-sized field.
  const window = source.subarray(position, Math.min(position + 2048 + 4, source.length))
  const length = window.indexOf('\r\n\r\n')
  if (length < 0 || length > 2048) malformed()
  const bytes = window.subarray(0, length)
  if (bytes.some(byte => byte > 126 || (byte < 32 && byte !== 13 && byte !== 10))) malformed()
  const headers = new Map<string, string>()
  for (const line of bytes.toString('ascii').split('\r\n')) {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon).toLowerCase()
    if (colon < 1 || !/^[a-z-]+$/.test(name)) malformed()
    if (headers.has(name) || (name !== 'content-disposition' && name !== 'content-type'))
      malformed()
    headers.set(name, line.slice(colon + 1).trim())
  }
  return { headers, start: position + length + 4 }
}

function partEnd(source: Buffer, delimiter: Buffer, start: number): number {
  let end = source.indexOf(delimiter, start)
  while (end !== -1) {
    const suffix = source
      .subarray(end + delimiter.length, end + delimiter.length + 2)
      .toString('ascii')
    if (suffix === '\r\n' || suffix === '--') return end
    end = source.indexOf(delimiter, end + delimiter.length)
  }
  return malformed()
}

function readPart(source: Buffer, delimiter: Buffer, position: number): Part {
  const { headers, start } = partHeaders(source, position)
  const disposition =
    /^form-data;\s*name="([^"\r\n]{1,128})"(?:;\s*filename="[^"\r\n]{0,256}")?$/i.exec(
      headers.get('content-disposition') ?? ''
    )
  if (disposition === null) malformed()
  const contentType = headers.get('content-type')
  if (contentType !== undefined) paymentPayloadContentType(contentType)
  const end = partEnd(source, delimiter, start)
  const suffix = end + delimiter.length
  const final = source.subarray(suffix, suffix + 2).toString('ascii') === '--'
  const next = suffix + 2
  if (final) {
    const epilogue = source.subarray(next).toString('ascii')
    if (epilogue !== '' && epilogue !== '\r\n') malformed()
  }
  return { name: disposition[1], contentType, bytes: source.subarray(start, end), next, final }
}

interface CollectedParts {
  paymentJSON?: string
  body?: Uint8Array
  contentType?: string
  invalid: boolean
}

function collectPart(result: CollectedParts, part: Part, maxPaymentBytes: number): void {
  if (part.name === 'x-bsv-payment') {
    if (
      part.contentType === undefined ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(part.contentType)
    )
      malformed()
    if (part.bytes.length > maxPaymentBytes)
      throw new PaymentTransportError(
        'ERR_PAYMENT_SIZE',
        'Multipart payment JSON exceeds its limit.'
      )
    result.paymentJSON = toUTF8Strict(part.bytes)
  } else if (part.name === 'body') {
    if (part.contentType === undefined) result.invalid = true
    // Own inner bytes so downstream views cannot retain or expose the outer payment part.
    result.body = new Uint8Array(part.bytes)
    result.contentType = part.contentType
  } else result.invalid = true
}

/** A bounded two-part RFC 7578 profile. Run only after authenticating the complete raw request. */
export function parseMultipartPayment(
  bytes: Uint8Array,
  contentType: string,
  maxBodyBytes: number,
  maxPaymentBytes: number
): ParsedMultipartPayment {
  if (!(bytes instanceof Uint8Array)) malformed()
  if (bytes.byteLength > maxBodyBytes)
    throw new PaymentTransportError('ERR_PAYMENT_SIZE', 'Multipart payment body exceeds its limit.')
  const boundary = paymentBoundary(contentType)
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const opening = Buffer.from(`--${boundary}\r\n`)
  if (source.equals(Buffer.from(`--${boundary}--\r\n`))) throw new MissingMultipartPayment()
  if (!source.subarray(0, opening.length).equals(opening)) malformed()
  let position = opening.length
  let parts = 0
  const result: CollectedParts = { invalid: false }
  const seen = new Set<string>()
  while (true) {
    if (++parts > 128) malformed()
    const part = readPart(source, delimiter, position)
    if (seen.has(part.name)) result.invalid = true
    seen.add(part.name)
    collectPart(result, part, maxPaymentBytes)
    if (part.final) break
    position = part.next
  }
  if (result.paymentJSON === undefined) throw new MissingMultipartPayment()
  if (result.invalid || parts > 2) malformed()
  return { paymentJSON: result.paymentJSON, body: result.body, contentType: result.contentType }
}
