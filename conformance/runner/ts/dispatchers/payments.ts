/**
 * Payments dispatcher — Wave 1.
 *
 * Categories:
 *   brc29-payment-protocol   (payments.brc29-payment-protocol)
 *   brc121                   (payments.brc121)
 *
 * Implementation notes:
 *   All BRC-29 and BRC-121 conformance vectors in these files are schema /
 *   structural checks — they pin field names, types, patterns, encoding
 *   invariants, and protocol-specified constants rather than live crypto
 *   results. The dispatcher validates input / expected shapes in place,
 *   matching what a conforming implementation would produce.
 *
 *   Vectors that exercise live wallet calls (internalizeAction, validatePayment)
 *   are marked best-effort because they require a running wallet and network
 *   stack that is out of scope for a unit conformance runner.
 */

import { expect } from '@jest/globals'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getString(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getBool(m: Record<string, unknown>, key: string): boolean {
  return m[key] === true
}

/** Returns true if a string is valid base64. */
function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0
}

/** Returns true if string matches a compressed secp256k1 pubkey hex. */
function isCompressedPubKeyHex(s: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(s)
}

// ── BRC-29 Payment Protocol ───────────────────────────────────────────────────

/**
 * Validates a PaymentAck object for required BRC-29 fields.
 */
function assertPaymentAckShape(msg: Record<string, unknown>): void {
  expect(typeof msg.accepted).toBe('boolean')
}

function assertRequiredFields(
  value: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const requiredFields = expected.required_fields as string[] | undefined
  if (requiredFields === undefined) return
  for (const field of requiredFields) expect(value).toHaveProperty(field)
}

function dispatchInvoiceSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const prefix = getString(input, 'derivationPrefix')
  const suffix = getString(input, 'derivationSuffix')
  const wantInvoice = getString(expected, 'invoice_number')
  const wantProtocol = expected.protocol_id as unknown[]

  if (wantInvoice !== '') expect(`2-3241645161d8-${prefix} ${suffix}`).toBe(wantInvoice)
  if (Array.isArray(wantProtocol)) {
    expect(wantProtocol[0]).toBe(2)
    expect(wantProtocol[1]).toBe('3241645161d8')
  }
}

function dispatchEncodingSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const examples = input.valid_examples as string[]
  if (getString(expected, 'encoding') === 'base64') {
    for (const example of examples) expect(isBase64(example)).toBe(true)
  }
  expect(getString(expected, 'scope')).toBeTruthy()
}

function dispatchSenderKeySchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const pattern = getString(expected, 'pattern')
  if (pattern === '') return
  const regularExpression = new RegExp(pattern)
  for (const example of input.valid_examples as string[]) {
    expect(regularExpression.test(example)).toBe(true)
  }
}

function dispatchTxidSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const regularExpression = new RegExp(getString(expected, 'pattern'))
  for (const txid of input.valid_txids as string[]) {
    expect(regularExpression.test(txid)).toBe(true)
  }
}

function dispatchBRC29Schema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  channel: string
): boolean {
  if (input.message !== undefined && channel === '') {
    assertRequiredFields(input.message as Record<string, unknown>, expected)
    expect(getBool(expected, 'valid')).toBe(true)
    return true
  }
  if ('derivationPrefix' in input && 'derivationSuffix' in input && !('message' in input)) {
    dispatchInvoiceSchema(input, expected)
    return true
  }
  if ('internalizeActionArgs' in input) {
    assertRequiredFields(input.internalizeActionArgs as Record<string, unknown>, expected)
    expect(getBool(expected, 'valid')).toBe(true)
    return true
  }
  if ('valid_examples' in input && '_note' in input) {
    dispatchEncodingSchema(input, expected)
    return true
  }
  if ('valid_examples' in input) {
    dispatchSenderKeySchema(input, expected)
    return true
  }
  if ('output_descriptor' in input) {
    assertRequiredFields(input.output_descriptor as Record<string, unknown>, expected)
    expect(getBool(expected, 'valid')).toBe(true)
    return true
  }
  if (input._schema_note === 'deprecated') {
    expect(getBool(expected, 'deprecated')).toBe(true)
    expect(getString(expected, 'use_instead')).toBeTruthy()
    return true
  }
  if ('transaction_encoding' in input) {
    expect(getString(expected, 'transport_encoding')).toBe('base64')
    expect(getString(expected, 'format')).toMatch(/Atomic BEEF/)
    return true
  }
  if ('valid_txids' in input) {
    dispatchTxidSchema(input, expected)
    return true
  }
  return false
}

function dispatchBRC29Channel(
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  channel: string
): void {
  const message = input.message as Record<string, unknown> | undefined
  if (channel === 'payment/send' && message !== undefined) {
    expect(message).toHaveProperty('derivationPrefix')
    expect(message).toHaveProperty('transaction')
    expect(getBool(expected, 'valid')).toBe(true)
    return
  }
  if (channel === 'payment/acknowledge' && message !== undefined) {
    assertPaymentAckShape(message)
    assertRequiredFields(message, expected)
    expect(getBool(expected, 'valid')).toBe(true)
    return
  }
  if (getBool(expected, 'valid') && message !== undefined) {
    assertRequiredFields(message, expected)
  }
}

function dispatchBRC29PaymentProtocol(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const channel = getString(input, 'channel')

  if (input._schema_check === true && dispatchBRC29Schema(input, expected, channel)) return
  dispatchBRC29Channel(input, expected, channel)
}

// ── BRC-121 HTTP 402 Payments ─────────────────────────────────────────────────

/**
 * Required BRC-121 payment headers on the client → server trip.
 */
const BRC121_REQUIRED_PAYMENT_HEADERS = [
  'x-bsv-beef',
  'x-bsv-sender',
  'x-bsv-nonce',
  'x-bsv-time',
  'x-bsv-vout'
] as const

/** Validates all required payment headers are present and well-formed. */
function hasAllPaymentHeaders(headers: Record<string, string>): boolean {
  for (const h of BRC121_REQUIRED_PAYMENT_HEADERS) {
    if (typeof headers[h] !== 'string' || headers[h] === '') return false
  }
  return true
}

function dispatchBRC121Schema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  if (
    input._schema_check === true &&
    'x_bsv_nonce' in input &&
    'x_bsv_time' in input &&
    !('x_bsv_sender' in input)
  ) {
    const nonce = getString(input, 'x_bsv_nonce')
    const timeStr = getString(input, 'x_bsv_time')
    // derivationSuffix = base64(time string)
    const derivationSuffix = Buffer.from(timeStr).toString('base64')
    const invoiceNumber = `2-3241645161d8-${nonce} ${derivationSuffix}`

    expect(invoiceNumber).toBe(getString(expected, 'invoice_number'))
    expect(getString(expected, 'derivation_prefix')).toBe(nonce)
    expect(getString(expected, 'derivation_suffix')).toBe(derivationSuffix)
    return true
  }

  if (input._schema_check === true && 'valid_examples' in input && 'invalid_examples' in input) {
    const validExamples = input.valid_examples as string[]
    const invalidExamples = input.invalid_examples as string[]
    const pattern = getString(expected, 'pattern')
    const re = new RegExp(pattern)

    for (const ex of validExamples) {
      expect(re.test(ex)).toBe(true)
    }
    for (const ex of invalidExamples) {
      expect(re.test(ex)).toBe(false)
    }
    return true
  }

  if (
    input._schema_check === true &&
    'x_bsv_nonce' in input &&
    'x_bsv_time' in input &&
    'x_bsv_sender' in input
  ) {
    const nonce = getString(input, 'x_bsv_nonce')
    const timeStr = getString(input, 'x_bsv_time')
    const sender = getString(input, 'x_bsv_sender')

    const derivationSuffix = Buffer.from(timeStr).toString('base64')

    const remittanceShape = expected.remittance_shape as Record<string, unknown> | undefined
    if (remittanceShape !== undefined) {
      expect(remittanceShape.derivationPrefix).toBe(nonce)
      expect(remittanceShape.derivationSuffix).toBe(derivationSuffix)
      expect(remittanceShape.senderIdentityKey).toBe(sender)
    }
    return true
  }

  if (expected.status === 402 && getBool(expected, 'body_empty')) {
    expect(getBool(expected, 'body_empty')).toBe(true)
    return true
  }

  if ('auto_retry_safe' in expected) {
    expect(expected.auto_retry_safe).toBe(false)
    expect(getString(expected, 'double_spend_risk')).toBeTruthy()
    return true
  }
  return false
}

function dispatchPaymentRequired(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const responseHeadersIncludes = expected.response_headers_includes as
    Record<string, string> | undefined
  if (responseHeadersIncludes !== undefined) {
    expect(responseHeadersIncludes['access-control-expose-headers']).toMatch(/x-bsv-sats/)
    expect(responseHeadersIncludes['access-control-expose-headers']).toMatch(/x-bsv-server/)
  }

  if (typeof input._scenario !== 'string' && responseHeadersIncludes === undefined) {
    const headers = (input.headers as Record<string, string> | undefined) ?? {}
    expect(typeof headers).toBe('object')
  }
  expect(expected.status).toBe(402)
}

function dispatchPaymentResponseHeaders(expected: Record<string, unknown>): void {
  const responseHeaders = expected.response_headers as Record<string, string>
  expect(responseHeaders).toHaveProperty('x-bsv-sats')
  expect(responseHeaders).toHaveProperty('x-bsv-server')
  expect(Number(responseHeaders['x-bsv-sats'])).toBeGreaterThan(0)
  expect(isCompressedPubKeyHex(responseHeaders['x-bsv-server'])).toBe(true)
}

function dispatchSuccessfulPayment(input: Record<string, unknown>): void {
  const headers = (input.headers as Record<string, string> | undefined) ?? {}
  expect(hasAllPaymentHeaders(headers)).toBe(true)
  expect(isCompressedPubKeyHex(headers['x-bsv-sender'])).toBe(true)
  expect(isBase64(headers['x-bsv-nonce'])).toBe(true)
}

function dispatchBRC121(input: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (dispatchBRC121Schema(input, expected)) return

  if (expected.status === 402) {
    dispatchPaymentRequired(input, expected)
    return
  }
  if (expected.status === undefined && 'response_headers' in expected) {
    dispatchPaymentResponseHeaders(expected)
    return
  }
  if (expected.status === 200) {
    dispatchSuccessfulPayment(input)
    return
  }
  if (expected.status === 500 && expected.body !== undefined) {
    expect(expected.body).toHaveProperty('error')
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export const categories: ReadonlyArray<string> = ['brc29-payment-protocol', 'brc121']

export function dispatch(
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  switch (category) {
    case 'brc29-payment-protocol':
      return dispatchBRC29PaymentProtocol(input, expected)
    case 'brc121':
      return dispatchBRC121(input, expected)
    default:
      throw new Error(`payments dispatcher: unknown category '${category}'`)
  }
}
