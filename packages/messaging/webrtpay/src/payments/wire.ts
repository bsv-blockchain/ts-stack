import { DEFAULTS, isIdentityKey } from '../types.js'
import type {
  PaymentRequestMessage,
  PaymentRequestResponse,
  PaymentToken,
  PaymentTokenInput,
  PubKeyHex
} from '../types.js'
import { fromBase64, toBase64 } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import { normalizePaymentRequest, normalizePaymentRequestResponse } from './requests.js'
import {
  invalidPayment,
  isByteArray,
  isMessageId,
  isShortString,
  optional,
  parsePaymentTransaction,
  plainRecord,
  tokenFields
} from './validate.js'

/** First handshake message: who I am and my fresh nonce. */
export interface Hello {
  t: 'hello'
  v: 1
  identityKey: PubKeyHex
  /** Standard base64 of exactly 32 random bytes. */
  nonce: string
}

/** Second handshake message: my signature over the channel-binding transcript. */
export interface Auth {
  t: 'auth'
  /** Lowercase hex, at most 200 characters. */
  signature: string
}

/**
 * Last handshake message: I verified your `auth` and accept full-size messages now.
 * Nothing but `hello`, `auth` and `ready` is sent before both sides have sent it.
 */
export interface Ready {
  t: 'ready'
}

/** A `PaymentToken` on the wire: the transaction is base64 Atomic BEEF. */
export interface PaymentWire {
  t: 'payment'
  /** 1–64 characters of `[A-Za-z0-9_-]`; echoed in the `payment.ack`. */
  id: string
  token: {
    customInstructions: { derivationPrefix: string; derivationSuffix: string }
    /** Standard base64 of the Atomic BEEF. */
    transaction: string
    amount: number
    outputIndex: number
  }
  note?: string
}

/** The payee's answer to a `payment` with the same `id`. */
export interface PaymentAck {
  t: 'payment.ack'
  id: string
  /** `received`: kept for a local internalize retry; `rejected`: see `reason`. */
  status: 'accepted' | 'received' | 'rejected'
  /** 64 lowercase hex characters. */
  txid?: string
  /** At most 500 characters. */
  reason?: string
}

export interface RequestWire {
  t: 'request'
  request: PaymentRequestMessage
}

export interface RequestResponseWire {
  t: 'request.response'
  response: PaymentRequestResponse
}

/** Sent before closing a session because of a problem. */
export interface ErrorWire {
  t: 'error'
  /** 1–64 characters, e.g. a `WebRTPayErrorCode`. */
  code: string
  /** At most 500 characters. */
  message?: string
}

/** Orderly end of a session. */
export interface Bye {
  t: 'bye'
}

/** Every JSON message carried on the data channel, discriminated by `t`. */
export type WireMessage =
  | Hello
  | Auth
  | Ready
  | PaymentWire
  | PaymentAck
  | RequestWire
  | RequestResponseWire
  | ErrorWire
  | Bye

const NONCE_BYTES = 32
const NONCE_CHARS = 44 // padded base64 of 32 bytes
const MAX_SIGNATURE_CHARS = 200
const SIGNATURE_RE = /^(?:[0-9a-f]{2})+$/
const TXID_RE = /^[0-9a-f]{64}$/
const MAX_REASON_CHARS = 500
const MAX_ERROR_CODE_CHARS = 64
const MAX_ERROR_MESSAGE_CHARS = 500
const MAX_NOTE_CHARS = 500
/** Longest base64 text that can decode to `DEFAULTS.maxMessageBytes` bytes. */
const MAX_TRANSACTION_CHARS = 4 * Math.ceil(DEFAULTS.maxMessageBytes / 3)
/**
 * Most UTF-8 bytes of a `payment` message besides its transaction's base64: a 64-character
 * id, two 400-character derivation strings, the largest amount and output index, a
 * 500-character note escaped to 6 bytes a character, and the JSON around them (4040).
 */
const PAYMENT_MESSAGE_OVERHEAD_BYTES = 4096

/**
 * Largest Atomic BEEF, in bytes, that can be delivered directly to a payee with the default
 * inbound cap of 16 MiB of JSON (`DEFAULTS.inboundMaxMessageBytes`): 12,579,840 bytes, about
 * 12 MiB, since base64 adds a third and the rest of the `payment` message takes up to 4096
 * bytes. `DirectPayClient.sendPayment` refuses a larger transaction with `too_large` before
 * sending anything. A payee with a lower `limits.maxMessageBytes` accepts less; it answers an
 * oversize message with `{ t: 'error', code: 'too_large' }` and closes the session.
 */
export const MAX_DIRECT_TRANSACTION_BYTES =
  Math.floor((DEFAULTS.inboundMaxMessageBytes - PAYMENT_MESSAGE_OVERHEAD_BYTES) / 4) * 3

function malformed(message: string): WebRTPayError {
  return new WebRTPayError('protocol', message)
}

function isNonce(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== NONCE_CHARS) return false
  try {
    return fromBase64(v).length === NONCE_BYTES
  } catch {
    return false
  }
}

function parseHello(r: Record<string, unknown>): Hello {
  const { v, identityKey, nonce } = r
  if (v !== 1 || !isIdentityKey(identityKey) || !isNonce(nonce)) {
    throw malformed('Malformed hello')
  }
  return { t: 'hello', v, identityKey, nonce }
}

function parseAuth(r: Record<string, unknown>): Auth {
  const { signature } = r
  if (!isShortString(signature, MAX_SIGNATURE_CHARS) || !SIGNATURE_RE.test(signature)) {
    throw malformed('Malformed auth')
  }
  return { t: 'auth', signature }
}

/**
 * Checks the payment's shape (types only) so that a payment with bad values still
 * reaches `decodePayment` and can be answered with a `rejected` ack.
 */
function parsePayment(r: Record<string, unknown>): PaymentWire {
  const { id } = r
  const note = optional(r.note)
  const token = plainRecord(r.token)
  const instructions = plainRecord(token?.customInstructions)
  if (!isMessageId(id) || token === undefined || instructions === undefined) {
    throw malformed('Malformed payment')
  }
  const { derivationPrefix, derivationSuffix } = instructions
  const { transaction, amount } = token
  const outputIndex = optional(token.outputIndex) ?? 0
  if (
    typeof derivationPrefix !== 'string' ||
    typeof derivationSuffix !== 'string' ||
    typeof transaction !== 'string' ||
    typeof amount !== 'number' ||
    typeof outputIndex !== 'number' ||
    (note !== undefined && typeof note !== 'string')
  ) {
    throw malformed('Malformed payment')
  }
  return {
    t: 'payment',
    id,
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction,
      amount,
      outputIndex
    },
    ...(note === undefined ? {} : { note })
  }
}

function parseAck(r: Record<string, unknown>): PaymentAck {
  const { id, status } = r
  const txid = optional(r.txid)
  const reason = optional(r.reason)
  if (
    !isMessageId(id) ||
    (status !== 'accepted' && status !== 'received' && status !== 'rejected') ||
    (txid !== undefined && (typeof txid !== 'string' || !TXID_RE.test(txid))) ||
    (reason !== undefined && !isShortString(reason, MAX_REASON_CHARS))
  ) {
    throw malformed('Malformed payment.ack')
  }
  return {
    t: 'payment.ack',
    id,
    status,
    ...(txid === undefined ? {} : { txid }),
    ...(reason === undefined ? {} : { reason })
  }
}

function parseRequest(r: Record<string, unknown>): RequestWire {
  // The authenticated peer key is not known here, so the request is checked against
  // the sender it names; receivers rebind it with normalizePaymentRequest(request, peer).
  const claimed = plainRecord(r.request)?.senderIdentityKey
  const sender = typeof claimed === 'string' ? claimed : ''
  return { t: 'request', request: normalizePaymentRequest(r.request, sender) }
}

function parseError(r: Record<string, unknown>): ErrorWire {
  const { code } = r
  const message = optional(r.message)
  if (
    !isShortString(code, MAX_ERROR_CODE_CHARS) ||
    code.length === 0 ||
    (message !== undefined && !isShortString(message, MAX_ERROR_MESSAGE_CHARS))
  ) {
    throw malformed('Malformed error')
  }
  return { t: 'error', code, ...(message === undefined ? {} : { message }) }
}

/**
 * Validates one decoded JSON value from the data channel and returns a fresh
 * `WireMessage` built from its known fields only: **unknown fields are stripped**, at
 * every level, never copied through. Optional fields that are `null` count as absent.
 *
 * Every field is type- and bounds-checked except the values inside a `payment` token,
 * which are only type-checked here; `decodePayment` checks those and throws
 * `invalid_payment`, so the receiver can answer with a `rejected` ack instead of
 * dropping the session. `request` is checked against the `senderIdentityKey` it
 * carries; bind it to the authenticated peer with `normalizePaymentRequest`.
 *
 * @throws WebRTPayError `protocol` for a non-object, an unknown `t`, or any violation.
 */
export function parseWireMessage(v: unknown): WireMessage {
  const r = plainRecord(v)
  if (r === undefined) throw malformed('Wire message is not a JSON object')
  switch (r.t) {
    case 'hello':
      return parseHello(r)
    case 'auth':
      return parseAuth(r)
    case 'ready':
      return { t: 'ready' }
    case 'payment':
      return parsePayment(r)
    case 'payment.ack':
      return parseAck(r)
    case 'request':
      return parseRequest(r)
    case 'request.response':
      return { t: 'request.response', response: normalizePaymentRequestResponse(r.response) }
    case 'error':
      return parseError(r)
    case 'bye':
      return { t: 'bye' }
    default:
      throw malformed('Unknown wire message type')
  }
}

/**
 * Builds the `payment` wire message for a token (its transaction a number array or a
 * `Uint8Array`); `outputIndex` defaults to 0. It checks nothing: see
 * {@link validatePaymentToken}.
 */
export function encodePayment(id: string, token: PaymentTokenInput, note?: string): PaymentWire {
  const { derivationPrefix, derivationSuffix } = token.customInstructions
  return {
    t: 'payment',
    id,
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: toBase64(Uint8Array.from(token.transaction)),
      amount: token.amount,
      outputIndex: token.outputIndex ?? 0
    },
    ...(note === undefined ? {} : { note })
  }
}

/**
 * Checks a payment token before it is sent, as the payee will: everything
 * {@link decodePayment} checks (strict base64 derivation prefix and suffix of 1–400
 * characters, an amount from 1 to 2.1e15, a uint32 output index, a transaction of bytes —
 * a `Uint8Array` or integers 0–255 — that parses as Atomic BEEF of at most 32 MiB, a note of
 * at most 500 characters), and that output `outputIndex` exists and carries exactly `amount`
 * satoshis. Only the payee can check that the output pays its key. Call it after creating
 * the transaction and before broadcasting it: a token it refuses would be acked `rejected`
 * after the money left. `DirectPayClient.sendPayment` calls it before sending.
 *
 * @throws WebRTPayError `invalid_payment` naming the first problem.
 */
export function validatePaymentToken(token: PaymentTokenInput, note?: string): void {
  const fields = tokenFields(token)
  if (!isByteArray(fields.transaction)) {
    throw invalidPayment('Payment transaction is not a byte array')
  }
  const tx = parsePaymentTransaction(fields.transaction)
  const output = tx.outputs[fields.outputIndex]
  if (output === undefined || output.satoshis !== fields.amount) {
    throw invalidPayment('Payment output does not carry the stated amount')
  }
  if (note !== undefined && !isShortString(note, MAX_NOTE_CHARS)) {
    throw invalidPayment('Payment note is invalid')
  }
}

/**
 * Turns a received `payment` into the `PaymentToken` handed to the app, plus its txid.
 * Checks: id format; transaction strict base64 of 1…`DEFAULTS.maxMessageBytes` bytes
 * that parses as Atomic BEEF; amount an integer 1…2.1e15; outputIndex uint32 (default
 * 0); derivation prefix and suffix strict base64 of 1–400 characters; note at most 500
 * characters. Does not check that the output pays anyone: see `verifyDirectPayment`.
 *
 * @throws WebRTPayError `invalid_payment` on any violation.
 */
export function decodePayment(w: PaymentWire): {
  id: string
  token: PaymentToken
  txid: string
  note?: string
} {
  const r = plainRecord(w)
  const id = r?.id
  if (r === undefined || !isMessageId(id)) throw invalidPayment('Payment id is invalid')
  const note = optional(r.note)
  if (note !== undefined && !isShortString(note, MAX_NOTE_CHARS)) {
    throw invalidPayment('Payment note is invalid')
  }
  const fields = tokenFields(r.token)
  const encoded = fields.transaction
  if (typeof encoded !== 'string' || encoded.length > MAX_TRANSACTION_CHARS) {
    throw invalidPayment('Payment transaction is invalid')
  }
  let bytes: Uint8Array
  try {
    bytes = fromBase64(encoded)
  } catch (cause) {
    throw invalidPayment('Payment transaction is not valid base64', cause)
  }
  const tx = parsePaymentTransaction(bytes)
  return {
    id,
    token: {
      customInstructions: {
        derivationPrefix: fields.derivationPrefix,
        derivationSuffix: fields.derivationSuffix
      },
      transaction: Array.from(bytes),
      amount: fields.amount,
      outputIndex: fields.outputIndex
    },
    txid: tx.id('hex'),
    ...(note === undefined ? {} : { note })
  }
}
