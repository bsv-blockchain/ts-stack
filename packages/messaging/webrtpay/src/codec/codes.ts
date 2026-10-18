/**
 * `webrtpay1:` offer and answer codes, exchanged out of band (QR or paste).
 *
 * Wire form: `CODE_PREFIX + base64url(body)`, at most {@link MAX_CODE_LENGTH} characters.
 * ```
 * offer:  [version u8 = 1][kind u8 = 1][sid, 16 bytes][payee identity key, 33 bytes][TLVs]
 * answer: [version u8 = 1][kind u8 = 2][sid, 16 bytes][TLVs]
 * TLVs: [tag u8][length varint][value]
 *   0x01 chain      UTF-8 (offer only)
 *   0x02 amount     varint satoshis, at least 1 (offer only)
 *   0x03 expiresAt  varint seconds since the epoch (offer only)
 *   0x10 sdp        encodeSdp bytes (required)
 * ```
 * Varints are unsigned LEB128, minimally encoded, at most 2^53 - 1. Unknown tags are
 * skipped; a repeated known tag is rejected.
 *
 * An answer carries no identity key: the payee learns the payer's key from the identity
 * handshake that follows, so writing it into a QR code would only show it to bystanders.
 */
import { CODE_PREFIX, isIdentityKey } from '../types.js'
import type { PubKeyHex } from '../types.js'
import {
  concatBytes,
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode
} from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import { decodeSdp, encodeSdp } from './sdp.js'

/** Shown by the payee: who they are, what they ask for, and their SDP offer. */
export interface OfferCode {
  kind: 'offer'
  /** 16-byte session id. */
  sid: Uint8Array
  /** The payee's identity key. */
  identityKey: PubKeyHex
  /** Network the payee is on, such as `'main'` or `'test'`. */
  chain?: string
  /** Requested amount in satoshis. */
  amount?: number
  /** When the offer stops being valid, in ms since the epoch; carried to the second (rounded down). */
  expiresAt?: number
  /** The payee's SDP offer. */
  sdp: string
}

/**
 * Shown by the payer in reply to an offer code: their SDP answer. It does not name the
 * payer; the handshake proves who they are.
 */
export interface AnswerCode {
  kind: 'answer'
  /** The session id of the offer being answered. */
  sid: Uint8Array
  /** The payer's SDP answer. */
  sdp: string
}

/** Longest code text accepted or produced, prefix included. */
export const MAX_CODE_LENGTH = 4000

const VERSION = 1
const KIND_OFFER = 1
const KIND_ANSWER = 2
const SID_BYTES = 16
const KEY_BYTES = 33
const ANSWER_HEADER_BYTES = 2 + SID_BYTES
const OFFER_HEADER_BYTES = ANSWER_HEADER_BYTES + KEY_BYTES

const TAG_CHAIN = 0x01
const TAG_AMOUNT = 0x02
const TAG_EXPIRES_AT = 0x03
const TAG_SDP = 0x10
const KNOWN_TAGS = new Set([TAG_CHAIN, TAG_AMOUNT, TAG_EXPIRES_AT, TAG_SDP])

/** Longest LEB128 encoding of a safe integer: ceil(53 / 7) bytes. */
const MAX_VARINT_BYTES = 8
const MAX_EXPIRES_AT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

function invalid(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('invalid_code', message, cause === undefined ? undefined : { cause })
}

/**
 * Encode an offer code. Throws `RangeError` for an invalid field and
 * `WebRTPayError('too_large')` when the code would exceed {@link MAX_CODE_LENGTH}.
 */
export function encodeOfferCode(c: Omit<OfferCode, 'kind'>): string {
  if (!isIdentityKey(c.identityKey)) {
    throw new RangeError('identityKey must be a compressed public key in lowercase hex')
  }
  const fields: Uint8Array[] = []
  if (c.chain !== undefined) fields.push(tlv(TAG_CHAIN, utf8Encode(c.chain)))
  if (c.amount !== undefined) {
    if (!Number.isSafeInteger(c.amount) || c.amount < 1) {
      throw new RangeError('amount must be a positive safe integer number of satoshis')
    }
    fields.push(tlv(TAG_AMOUNT, varint(c.amount)))
  }
  if (c.expiresAt !== undefined) {
    if (!(c.expiresAt >= 0 && c.expiresAt <= Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('expiresAt must be a non-negative safe number of ms since the epoch')
    }
    fields.push(tlv(TAG_EXPIRES_AT, varint(Math.floor(c.expiresAt / 1000))))
  }
  return encodeCode(KIND_OFFER, c, [fromHex(c.identityKey)], fields)
}

/**
 * Encode an answer code. Throws `RangeError` for an invalid field and
 * `WebRTPayError('too_large')` when the code would exceed {@link MAX_CODE_LENGTH}.
 */
export function encodeAnswerCode(c: Omit<AnswerCode, 'kind'>): string {
  return encodeCode(KIND_ANSWER, c, [], [])
}

/**
 * Decode an offer or answer code. Surrounding whitespace is ignored. Throws
 * `WebRTPayError('invalid_code')` when the text is malformed, the offer has expired
 * (`now`, default `Date.now()`, is at or past `expiresAt`), or `expectedChain` is given
 * and an offer's chain is missing or different.
 */
export function decodeCode(
  text: string,
  opts: { expectedChain?: string; now?: number } = {}
): OfferCode | AnswerCode {
  const body = codeBody(text)
  const { sid, identityKey, headerBytes } = readHeader(body)
  const fields = readFields(body, headerBytes)
  const sdpBytes = fields.get(TAG_SDP)
  if (sdpBytes === undefined) throw invalid('Code has no SDP')
  const sdp = decodeSdp(sdpBytes)

  if (identityKey === undefined) {
    if (fields.has(TAG_CHAIN) || fields.has(TAG_AMOUNT) || fields.has(TAG_EXPIRES_AT)) {
      throw invalid('Answer code carries offer-only fields')
    }
    return { kind: 'answer', sid, sdp }
  }

  const offer: OfferCode = { kind: 'offer', sid, identityKey, sdp }
  readOfferFields(offer, fields)
  assertOfferUsable(offer, opts)
  return offer
}

/**
 * The bytes a code's text carries. Checks, in order: the type, the length before trimming,
 * the prefix, then the base64url after it.
 */
function codeBody(text: string): Uint8Array {
  if (typeof text !== 'string') throw invalid('Code must be a string')
  if (text.length > MAX_CODE_LENGTH) {
    throw invalid(`Code is longer than ${MAX_CODE_LENGTH} characters`)
  }
  const trimmed = text.trim()
  if (!trimmed.startsWith(CODE_PREFIX)) throw invalid(`Code does not start with ${CODE_PREFIX}`)
  try {
    return fromBase64Url(trimmed.slice(CODE_PREFIX.length))
  } catch (cause) {
    throw invalid('Code is not valid base64url', cause)
  }
}

/** The part of a code before its TLVs. */
interface CodeHeader {
  sid: Uint8Array
  /** The payee's identity key; only an offer carries one. */
  identityKey?: PubKeyHex
  /** Where the TLVs start. */
  headerBytes: number
}

/**
 * `[version][kind][sid]`, then an offer's identity key. Checks, in order: the length of
 * the common part, the version, the kind, then an offer's length and key.
 */
function readHeader(body: Uint8Array): CodeHeader {
  if (body.length < ANSWER_HEADER_BYTES) throw invalid('Code is truncated')
  if (body[0] !== VERSION) throw invalid(`Unsupported code version ${body[0]}`)
  const kind = body[1]
  if (kind !== KIND_OFFER && kind !== KIND_ANSWER) throw invalid(`Unknown code kind ${kind}`)
  const sid = body.slice(2, 2 + SID_BYTES)
  // Only an offer names its sender (the payee); an answer's TLVs follow the sid.
  if (kind === KIND_ANSWER) return { sid, headerBytes: ANSWER_HEADER_BYTES }
  if (body.length < OFFER_HEADER_BYTES) throw invalid('Code is truncated')
  const identityKey = toHex(body.subarray(ANSWER_HEADER_BYTES, OFFER_HEADER_BYTES))
  if (!isIdentityKey(identityKey)) throw invalid('Code carries an invalid identity key')
  return { sid, identityKey, headerBytes: OFFER_HEADER_BYTES }
}

/**
 * Set the optional fields `fields` carries on `offer`: chain, then amount, then expiry. A
 * malformed one throws, the first in that order whatever the order of the TLVs.
 */
function readOfferFields(offer: OfferCode, fields: Map<number, Uint8Array>): void {
  const chain = fields.get(TAG_CHAIN)
  if (chain !== undefined) {
    try {
      offer.chain = utf8Decode(chain)
    } catch (cause) {
      throw invalid('Code chain is not valid UTF-8', cause)
    }
  }
  const amount = fields.get(TAG_AMOUNT)
  if (amount !== undefined) {
    offer.amount = readWholeVarint(amount)
    if (offer.amount < 1) throw invalid('Code amount must be at least 1 satoshi')
  }
  const expiresAt = fields.get(TAG_EXPIRES_AT)
  if (expiresAt !== undefined) {
    const seconds = readWholeVarint(expiresAt)
    if (seconds > MAX_EXPIRES_AT_SECONDS) throw invalid('Code expiry is out of range')
    offer.expiresAt = seconds * 1000
  }
}

/**
 * Throw when `offer` has expired (`opts.now`, default `Date.now()`, is at or past its
 * `expiresAt`), then when `opts.expectedChain` is given and the offer's chain is missing or
 * different.
 */
function assertOfferUsable(offer: OfferCode, opts: { expectedChain?: string; now?: number }): void {
  if (offer.expiresAt !== undefined && (opts.now ?? Date.now()) >= offer.expiresAt) {
    throw invalid('Offer code has expired')
  }
  if (opts.expectedChain !== undefined && offer.chain !== opts.expectedChain) {
    throw invalid(
      offer.chain === undefined
        ? `Offer code does not name a network; expected ${opts.expectedChain}`
        : `Offer code is for a different network; expected ${opts.expectedChain}`
    )
  }
}

/** `[version][kind][sid]`, then `header` (the offer's key), then `fields` and the sdp TLV. */
function encodeCode(
  kind: number,
  c: { sid: Uint8Array; sdp: string },
  header: Uint8Array[],
  fields: Uint8Array[]
): string {
  if (!(c.sid instanceof Uint8Array) || c.sid.length !== SID_BYTES) {
    throw new RangeError(`sid must be ${SID_BYTES} bytes`)
  }
  const body = concatBytes(
    Uint8Array.of(VERSION, kind),
    c.sid,
    ...header,
    ...fields,
    tlv(TAG_SDP, encodeSdp(c.sdp))
  )
  const text = CODE_PREFIX + toBase64Url(body)
  if (text.length > MAX_CODE_LENGTH) {
    throw new WebRTPayError(
      'too_large',
      `Code would be ${text.length} characters; the limit is ${MAX_CODE_LENGTH}`
    )
  }
  return text
}

/** Known TLV values from `start` (the end of the header) on, by tag; unknown tags are skipped. */
function readFields(body: Uint8Array, start: number): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>()
  let o = start
  while (o < body.length) {
    const tag = body[o]
    const length = readVarint(body, o + 1)
    o = length.end
    if (length.value > body.length - o) throw invalid('Code field runs past the end')
    const value = body.subarray(o, o + length.value)
    o += length.value
    if (!KNOWN_TAGS.has(tag)) continue
    if (fields.has(tag)) throw invalid(`Code repeats field ${tag}`)
    fields.set(tag, value)
  }
  return fields
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), varint(value.length), value)
}

/** Unsigned LEB128 of a non-negative safe integer. */
function varint(n: number): Uint8Array {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return Uint8Array.from(out)
}

/** A minimal LEB128 varint at `offset`, at most 2^53 - 1. */
function readVarint(b: Uint8Array, offset: number): { value: number; end: number } {
  let value = 0
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset + i >= b.length) throw invalid('Code varint is truncated')
    const byte = b[offset + i]
    value += (byte & 0x7f) * 2 ** (7 * i)
    if (value > Number.MAX_SAFE_INTEGER) throw invalid('Code varint is too large')
    if ((byte & 0x80) === 0) {
      if (byte === 0 && i > 0) throw invalid('Code varint is not minimally encoded')
      return { value, end: offset + i + 1 }
    }
  }
  throw invalid('Code varint is too long')
}

/** A varint that must fill `b` exactly. */
function readWholeVarint(b: Uint8Array): number {
  const { value, end } = readVarint(b, 0)
  if (end !== b.length) throw invalid('Code number has trailing bytes')
  return value
}
