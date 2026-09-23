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

/** A bounded two-part RFC 7578 profile. Run only after authenticating the complete raw request. */
export function parseMultipartPayment(
  bytes: Uint8Array,
  contentType: string,
  maxBodyBytes: number,
  maxPaymentBytes: number
): ParsedMultipartPayment {
  const malformed = (): never => {
    throw new PaymentTransportError('ERR_PAYMENT_TRANSPORT', 'Malformed multipart payment.')
  }
  if (bytes.length > maxBodyBytes)
    throw new PaymentTransportError('ERR_PAYMENT_SIZE', 'Multipart payment body exceeds its limit.')
  const boundary = paymentBoundary(contentType)
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const opening = Buffer.from(`--${boundary}\r\n`)
  if (source.equals(Buffer.from(`--${boundary}--\r\n`))) throw new MissingMultipartPayment()
  if (!source.subarray(0, opening.length).equals(opening)) malformed()
  let position = opening.length
  let paymentJSON: string | undefined
  let body: Uint8Array | undefined
  let bodyType: string | undefined
  let parts = 0
  let invalidPaymentProfile = false
  const seen = new Set<string>()
  while (true) {
    if (++parts > 128) malformed()
    // Bound the header search itself, before reading any attacker-sized field.
    const headerWindow = source.subarray(position, Math.min(position + 2048 + 4, source.length))
    const headerLength = headerWindow.indexOf('\r\n\r\n')
    if (headerLength < 0 || headerLength > 2048) malformed()
    const rawHeaders = headerWindow.subarray(0, headerLength).toString('ascii')
    if (
      headerWindow
        .subarray(0, headerLength)
        .some(byte => byte > 126 || (byte < 32 && byte !== 13 && byte !== 10))
    )
      malformed()
    const headers = new Map<string, string>()
    for (const line of rawHeaders.split('\r\n')) {
      const match = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line)
      if (match === null) malformed()
      const name = match![1].toLowerCase()
      if (headers.has(name) || (name !== 'content-disposition' && name !== 'content-type'))
        malformed()
      headers.set(name, match![2].trim())
    }
    const disposition =
      /^form-data;\s*name="([^"\r\n]{1,128})"(?:;\s*filename="[^"\r\n]{0,256}")?$/i.exec(
        headers.get('content-disposition') ?? ''
      )
    if (disposition === null) malformed()
    const name = disposition![1]
    if (seen.has(name)) invalidPaymentProfile = true
    seen.add(name)
    const partType = headers.get('content-type')
    if (partType !== undefined) paymentPayloadContentType(partType)
    const start = position + headerLength + 4
    let end = source.indexOf(delimiter, start)
    while (end !== -1) {
      const suffix = source
        .subarray(end + delimiter.length, end + delimiter.length + 2)
        .toString('ascii')
      if (suffix === '\r\n' || suffix === '--') break
      end = source.indexOf(delimiter, end + delimiter.length)
    }
    if (end === -1) malformed()
    if (name === 'x-bsv-payment') {
      if (partType === undefined || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(partType))
        malformed()
      if (end - start > maxPaymentBytes)
        throw new PaymentTransportError(
          'ERR_PAYMENT_SIZE',
          'Multipart payment JSON exceeds its limit.'
        )
      paymentJSON = toUTF8Strict(source.subarray(start, end))
    } else if (name === 'body') {
      if (partType === undefined) invalidPaymentProfile = true
      // Own the inner bytes: downstream views must not retain or expose the outer payment part.
      body = new Uint8Array(source.subarray(start, end))
      bodyType = partType
    } else invalidPaymentProfile = true
    position = end + delimiter.length
    if (source.subarray(position, position + 2).toString('ascii') === '--') {
      position += 2
      if (
        source.subarray(position).toString('ascii') !== '' &&
        source.subarray(position).toString('ascii') !== '\r\n'
      )
        malformed()
      break
    }
    position += 2
  }
  if (paymentJSON === undefined) throw new MissingMultipartPayment()
  if (invalidPaymentProfile || parts > 2) malformed()
  return { paymentJSON: paymentJSON!, body, contentType: bodyType }
}
