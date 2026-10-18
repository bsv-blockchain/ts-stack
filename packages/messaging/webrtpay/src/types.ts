import { PublicKey } from '@bsv/sdk'
import type { PubKeyHex, WalletInterface, WalletProtocol } from '@bsv/sdk'

/**
 * `@bsv/sdk`'s `PubKeyHex`: a public key in hex. Identity keys in this package are
 * compressed secp256k1 keys, 66 lowercase hex characters (see {@link isIdentityKey}).
 */
export type { PubKeyHex } from '@bsv/sdk'

/**
 * Atomic BEEF (BRC-95) transaction bytes as a plain number array: the form this package
 * hands out. Narrower than `@bsv/sdk`'s `AtomicBEEF` of the same name (`number[] |
 * Uint8Array`), which the input types below accept.
 */
export type AtomicBEEF = number[]

/**
 * A payment as given to this package (`sendPayment`, `encodePayment`,
 * `validatePaymentToken`): the transaction, as a number array or a `Uint8Array` like
 * `@bsv/sdk`'s `AtomicBEEF` (`createAction`'s `tx`), plus the derivation values the
 * recipient needs to take custody of the output. PeerPay's `PaymentToken` is one.
 */
export interface PaymentTokenInput {
  customInstructions: {
    derivationPrefix: string
    derivationSuffix: string
  }
  transaction: number[] | Uint8Array
  amount: number
  outputIndex?: number
}

/**
 * A payment as carried in a PeerPay-compatible message, as this package hands it out:
 * the transaction is always a number array.
 */
export interface PaymentToken extends PaymentTokenInput {
  transaction: AtomicBEEF
}

/**
 * A received payment as given to `acceptDirectPayment` and `verifyDirectPayment`, its
 * transaction a number array or a `Uint8Array`. PeerPay's `IncomingPayment` is one.
 */
export interface IncomingPaymentInput {
  messageId: string
  sender: string
  token: PaymentTokenInput
  outputIndex?: number
}

/** A payment received from a peer, ready for `internalizeAction`. */
export interface IncomingPayment extends IncomingPaymentInput {
  token: PaymentToken
}

/**
 * Base fields shared by both payment request and cancellation messages.
 */
interface PaymentRequestBase {
  /** Unique identifier for this request, generated via createNonce(). */
  requestId: string
  /** Identity key of the requester, used for correlation and cancellation verification. */
  senderIdentityKey: string
}

/**
 * A new payment request sent from requester to payer.
 * Carried in the 'payment_requests' message box.
 */
export interface PaymentRequestNew extends PaymentRequestBase {
  /** Amount in satoshis being requested. */
  amount: number
  /** Human-readable reason for the request. */
  description: string
  /** Unix timestamp (ms) after which the request expires. Set by the sender. */
  expiresAt: number
  /** HMAC proof tying this request to the sender's identity. Used to authorize cancellations. */
  requestProof: string
  /** Omitted or false for a new payment request. */
  cancelled?: false
}

/**
 * A cancellation of a previously sent payment request.
 * Carried in the 'payment_requests' message box.
 */
export interface PaymentRequestCancellation extends PaymentRequestBase {
  /** If true, this message cancels a previously sent request with the same requestId. */
  cancelled: true
  /** HMAC proof from the original request, proving cancellation authority. */
  requestProof: string
}

/**
 * Discriminated union: either a new payment request or a cancellation.
 * Discriminant field: `cancelled` (true = cancellation, absent/false = new request).
 */
export type PaymentRequestMessage = PaymentRequestNew | PaymentRequestCancellation

/**
 * Represents a response to a payment request, sent from the payer back to the requester.
 * Carried in the 'payment_request_responses' message box.
 */
export interface PaymentRequestResponse {
  /** Authenticated envelope message ID. Present on list/live receive results, absent on send bodies. */
  messageId?: string
  /** Authenticated envelope sender. Present on list/live receive results, absent on send bodies. */
  sender?: string
  /** The requestId of the original PaymentRequestMessage this responds to. */
  requestId: string
  /** Status of the response. */
  status: 'paid' | 'declined'
  /** Optional note from the payer. */
  note?: string
  /** Actual amount paid in satoshis (may differ from the requested amount). */
  amountPaid?: number
}

/**
 * Represents an incoming payment request as returned by listIncomingPaymentRequests().
 * Combines the transport message metadata with the parsed request body.
 * Only active (non-cancelled) requests are returned, so cancelled field is omitted.
 */
export interface IncomingPaymentRequest {
  /** Transport message ID used for acknowledgment. */
  messageId: string
  /** Identity key of the requester. */
  sender: string
  /** Unique identifier for this request. */
  requestId: string
  /** Amount in satoshis requested. */
  amount: number
  /** Human-readable reason for the request. */
  description: string
  /** Unix timestamp (ms) when the request expires. */
  expiresAt: number
}

/**
 * The slice of a BRC-100 wallet this package uses: identity and payment key
 * derivation, signatures, HMACs, encryption and internalizing received payments.
 */
export type WalletLike = Pick<
  WalletInterface,
  | 'getPublicKey'
  | 'createSignature'
  | 'verifySignature'
  | 'encrypt'
  | 'decrypt'
  | 'createHmac'
  | 'verifyHmac'
  | 'internalizeAction'
>

/** Payment key derivation: keyID is `"<derivationPrefix> <derivationSuffix>"` (BRC-29). */
export const PAYMENT_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']
/** Binds a data channel's identity handshake to the peers' DTLS transcript. */
export const CHANNEL_PROTOCOL_ID: WalletProtocol = [2, 'webrtpay channel']
/** Encrypts signaling envelopes (offer, answer, reject) between two identities. */
export const SIGNALING_PROTOCOL_ID: WalletProtocol = [2, 'webrtpay signaling']
/** Authenticates a websocket to the relay server. */
export const RELAY_PROTOCOL_ID: WalletProtocol = [2, 'webrtpay relay']
/** HMAC proof on payment requests (message-box-client compatible). */
export const PAYMENT_REQUEST_PROTOCOL_ID: WalletProtocol = [2, 'payment request auth']

/** Label of the single data channel: ordered and fully reliable. */
export const CHANNEL_LABEL = 'webrtpay/1'
/** MessageBox box that carries signaling envelopes. */
export const SIGNALS_MESSAGEBOX = 'webrtpay_signals'
/** Prefix of offer and answer codes exchanged out of band. */
export const CODE_PREFIX = 'webrtpay1:'

/** Numeric defaults; sizes are in bytes, durations in milliseconds. */
export interface Defaults {
  /** Largest data channel frame, including its 6-byte header. */
  readonly chunkBytes: number
  /** Largest reassembled message accepted by default. */
  readonly maxMessageBytes: number
  /** Largest reassembled message a payee accepts from an inbound peer. */
  readonly inboundMaxMessageBytes: number
  /** How long to wait for ICE gathering before sending a non-trickle offer or answer. */
  readonly gatherTimeoutMs: number
  /** Time allowed for the identity handshake once the channel is open. */
  readonly handshakeTimeoutMs: number
  /** Total budget for connect plus handshake when dialing. */
  readonly connectTimeoutMs: number
  /** How long a payer waits for the payee's ack. */
  readonly ackTimeoutMs: number
  /** Allowed clock skew either way on a signal envelope timestamp. */
  readonly signalMaxSkewMs: number
  /** Payee polling interval for incoming signals over MessageBox. */
  readonly payeePollMs: number
  /** Payer polling interval for the answer while dialing over MessageBox. */
  readonly payerPollMs: number
}

export const DEFAULTS: Defaults = Object.freeze({
  chunkBytes: 16384,
  maxMessageBytes: 32 * 1024 * 1024,
  inboundMaxMessageBytes: 16 * 1024 * 1024,
  gatherTimeoutMs: 5000,
  handshakeTimeoutMs: 15000,
  connectTimeoutMs: 30000,
  ackTimeoutMs: 45000,
  signalMaxSkewMs: 120000,
  payeePollMs: 2500,
  payerPollMs: 1000
})

const IDENTITY_KEY_RE = /^(02|03)[0-9a-f]{64}$/

/**
 * True for a canonical compressed secp256k1 public key: 66 lowercase hex characters
 * starting 02 or 03 that is a valid curve point and round-trips through
 * `PublicKey` unchanged.
 */
export function isIdentityKey(v: unknown): v is PubKeyHex {
  if (typeof v !== 'string' || !IDENTITY_KEY_RE.test(v)) return false
  try {
    return PublicKey.fromString(v).toString() === v
  } catch {
    return false
  }
}
