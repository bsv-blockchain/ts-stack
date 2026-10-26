import { PAYMENT_REQUEST_PROTOCOL_ID, isIdentityKey } from '../types.js'
import type {
  PaymentRequestMessage,
  PaymentRequestResponse,
  PubKeyHex,
  WalletLike
} from '../types.js'
import { fromHex, toHex, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import { isBoundedText, isIntInRange, optional, plainRecord } from './validate.js'

// Bounds match message-box-client's PeerPayClient.
const MAX_REQUEST_ID_BYTES = 1024
const MAX_DESCRIPTION_BYTES = 2000
const PROOF_RE = /^[0-9a-f]{64}$/

function malformed(message: string): WebRTPayError {
  return new WebRTPayError('protocol', message)
}

/** HMAC input: UTF-8 of `requestId + recipient`, as message-box-client computes it. */
function proofData(requestId: string, recipient: string): number[] {
  return Array.from(utf8Encode(requestId + recipient))
}

/**
 * Creates the proof a requester attaches to a payment request (and repeats in its
 * cancellation): lowercase hex of the wallet HMAC over UTF-8 `requestId + recipient`
 * with `PAYMENT_REQUEST_PROTOCOL_ID`, keyID `requestId`, counterparty `recipient`.
 * Identical to message-box-client's `requestPayment` proof.
 *
 * @throws TypeError if `requestId` is not 1–1024 bytes of text without control
 * characters or `recipient` is not an identity key (the proof could never verify).
 */
export async function createPaymentRequestProof(
  wallet: WalletLike,
  requestId: string,
  recipient: PubKeyHex,
  originator?: string
): Promise<string> {
  if (!isBoundedText(requestId, MAX_REQUEST_ID_BYTES)) {
    throw new TypeError('Payment request ID is invalid')
  }
  if (!isIdentityKey(recipient)) {
    throw new TypeError('Payment request recipient must be an identity key')
  }
  const { hmac } = await wallet.createHmac(
    {
      data: proofData(requestId, recipient),
      protocolID: PAYMENT_REQUEST_PROTOCOL_ID,
      keyID: requestId,
      counterparty: recipient
    },
    originator
  )
  const bytes = Array.from(hmac)
  if (bytes.length !== 32 || !bytes.every(b => isIntInRange(b, 0, 255))) {
    throw new Error('Wallet returned an invalid payment request proof')
  }
  return toHex(Uint8Array.from(bytes))
}

/**
 * Checks a request's (or cancellation's) proof: `sender` must have created it for
 * `myIdentityKey`. Returns `false`, never throws, when the proof is malformed, does not
 * verify, either key is not an identity key, or the wallet fails (fail closed).
 */
export async function verifyPaymentRequestProof(
  wallet: WalletLike,
  req: PaymentRequestMessage,
  myIdentityKey: string,
  sender: string,
  originator?: string
): Promise<boolean> {
  const r = plainRecord(req)
  if (r === undefined || !isIdentityKey(myIdentityKey) || !isIdentityKey(sender)) return false
  const { requestId, requestProof } = r
  if (typeof requestId !== 'string' || typeof requestProof !== 'string') return false
  if (!PROOF_RE.test(requestProof)) return false
  try {
    const { valid } = await wallet.verifyHmac(
      {
        data: proofData(requestId, myIdentityKey),
        hmac: Array.from(fromHex(requestProof)),
        protocolID: PAYMENT_REQUEST_PROTOCOL_ID,
        keyID: requestId,
        counterparty: sender
      },
      originator
    )
    return valid === true
  } catch {
    // Wallets throw (ERR_INVALID_HMAC) rather than return { valid: false }.
    return false
  }
}

/**
 * Validates a payment request or cancellation received from `sender` (the
 * authenticated peer) and returns a fresh object with only the known fields.
 * Mirrors message-box-client's checks: `senderIdentityKey === sender`, requestId 1–1024
 * bytes and description 1–2000 bytes of text without control characters, proof 64
 * lowercase hex, amount and expiresAt positive safe integers. A cancellation
 * (`cancelled: true`) keeps only requestId, senderIdentityKey and requestProof. Expiry
 * against the clock is left to the caller.
 *
 * @throws WebRTPayError `protocol` on any violation.
 */
export function normalizePaymentRequest(v: unknown, sender: string): PaymentRequestMessage {
  const r = plainRecord(v)
  if (r === undefined) throw malformed('Payment request is not an object')
  if (!isIdentityKey(sender) || r.senderIdentityKey !== sender) {
    throw malformed('Payment request sender does not match the peer')
  }
  const { requestId, requestProof, cancelled } = r
  if (!isBoundedText(requestId, MAX_REQUEST_ID_BYTES)) {
    throw malformed('Payment request ID is invalid')
  }
  if (typeof requestProof !== 'string' || !PROOF_RE.test(requestProof)) {
    throw malformed('Payment request proof is invalid')
  }
  if (cancelled === true) {
    return { requestId, senderIdentityKey: sender, requestProof, cancelled: true }
  }
  if (optional(cancelled) !== undefined && cancelled !== false) {
    throw malformed('Payment request cancelled flag is invalid')
  }
  const { amount, description, expiresAt } = r
  if (
    !isIntInRange(amount, 1, Number.MAX_SAFE_INTEGER) ||
    !isIntInRange(expiresAt, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw malformed('Payment request amount or expiry is invalid')
  }
  if (!isBoundedText(description, MAX_DESCRIPTION_BYTES)) {
    throw malformed('Payment request description is invalid')
  }
  return { requestId, senderIdentityKey: sender, amount, description, expiresAt, requestProof }
}

/**
 * Validates a response to a payment request and returns a fresh object with only
 * requestId, status, note and (for `paid`) amountPaid. The envelope fields `messageId`
 * and `sender` are dropped: over a direct session the sender is the authenticated peer,
 * never a claim in the body. `paid` requires a positive safe-integer `amountPaid`;
 * note is 1–2000 bytes of text without control characters.
 *
 * @throws WebRTPayError `protocol` on any violation.
 */
export function normalizePaymentRequestResponse(v: unknown): PaymentRequestResponse {
  const r = plainRecord(v)
  if (r === undefined) throw malformed('Payment request response is not an object')
  const { requestId, status, amountPaid } = r
  const note = optional(r.note)
  if (!isBoundedText(requestId, MAX_REQUEST_ID_BYTES)) {
    throw malformed('Payment request response ID is invalid')
  }
  if (note !== undefined && !isBoundedText(note, MAX_DESCRIPTION_BYTES)) {
    throw malformed('Payment request response note is invalid')
  }
  const withNote = note === undefined ? {} : { note }
  if (status === 'declined') return { requestId, status, ...withNote }
  if (status !== 'paid' || !isIntInRange(amountPaid, 1, Number.MAX_SAFE_INTEGER)) {
    throw malformed('Payment request response status or amount is invalid')
  }
  return { requestId, status, amountPaid, ...withNote }
}
