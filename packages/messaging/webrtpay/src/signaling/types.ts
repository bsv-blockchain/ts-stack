import type { PubKeyHex } from '../types.js'

/**
 * What a carrier transports: an end-to-end encrypted {@link SignalPlaintext}. The
 * `sid` travels in the clear because it is also the encryption key ID.
 */
export interface SignalEnvelope {
  v: 1
  sid: string
  /** Standard base64 of the BRC-2 ciphertext of the JSON plaintext. */
  ciphertext: string
}

/**
 * The kind of signal: an SDP offer, the SDP answer to it, or a refusal to answer; a
 * `knock` asks whether the recipient is there before any ICE is gathered, and `ring` is the
 * recipient's reply that it is and will take the offer. `knock` and `ring` carry no `sdp`
 * and no `reason`.
 */
export type SignalKind = 'offer' | 'answer' | 'reject' | 'knock' | 'ring'

/** The decrypted content of a {@link SignalEnvelope}. */
export interface SignalPlaintext {
  v: 1
  kind: SignalKind
  /**
   * Session ID shared by a dial's knock, ring, offer and answer or reject; 16 random bytes,
   * base64url.
   */
  sid: string
  from: PubKeyHex
  to: PubKeyHex
  /** Sender clock, Unix milliseconds. */
  ts: number
  purpose: 'payment'
  /** Full SDP text (offer and answer only). */
  sdp?: string
  /** Why the peer refused (reject only): `busy`, `not_receiving` or `wrong_network`. */
  reason?: string
  /**
   * The network the sender's wallet is on, such as `main` or `test`: 1 to 16 characters from
   * `a-z` and `0-9`. A client given a `chain` names it in its offers and answers and refuses
   * a peer that names another network or none; absent means unknown.
   */
  chain?: string
}

/**
 * A carrier for signal envelopes between identities. It never sees plaintext; the
 * `from` it reports is the identity the carrier asserts, which `openSignal` checks
 * against the encrypted content.
 */
export interface Signaler {
  /** Send an already-encrypted envelope to a peer identity. */
  send(to: PubKeyHex, e: SignalEnvelope): Promise<void>
  /**
   * Receive envelopes addressed to us. Resolves once listening has started, with a
   * function that stops this subscription.
   */
  listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>>
  /** Hint that a dial is in progress, so answers should be picked up faster. */
  setActive?(active: boolean): void
}
