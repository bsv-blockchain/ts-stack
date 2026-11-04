/**
 * The identifier a reply or a reaction names.
 *
 * `MessageContent.replyTo` and `Reaction.reference` have always held an id the
 * library did not define, which left every host to invent one — and two hosts
 * inventing differently do not interoperate, where the rest of the envelope
 * merely costs them effort.
 *
 * Derived rather than carried, the way `draft-ietf-mimi-content` derives its
 * own message ids: the sender does not get to choose it, so it cannot collide
 * by accident or be claimed by forgery. The preimage is the MLS application
 * message — one ciphertext, broadcast unchanged to every member, unique per
 * message because MLS framing is. Sender and recipients therefore hash exactly
 * the same bytes without agreeing on a canonical JSON form, which is the usual
 * way a scheme like this goes wrong.
 *
 * Re-sending the same bytes — what `retryDelivery` does — keeps the id, since
 * it is the same message. Encrypting the same text a second time does not,
 * since it is not.
 *
 * `Hash.sha256` rather than `crypto.subtle.digest`: it is pure JavaScript, so
 * this works on a React Native runtime whose WebCrypto is partial.
 */
import { Hash } from '@bsv/sdk'
import { toHex } from './bytes.js'

/** A sha-256 digest in lower-case hex. */
export type MessageId = string

/**
 * Derive the id of an MLS application message.
 *
 * Public and deterministic, so it is an identifier rather than a capability:
 * anyone holding the ciphertext can compute it, and holding one proves
 * nothing. Nothing may turn on knowing an id — authorise on group membership
 * and the MLS sender, which is what the framing already authenticates.
 */
export const messageIdOf = (message: Uint8Array): MessageId =>
  // `Hash.sha256` takes a `Uint8Array` as it stands. Converting to a plain
  // array first allocated one JS number per byte on a path that runs for every
  // message sent and every message received.
  toHex(Hash.sha256(message))
