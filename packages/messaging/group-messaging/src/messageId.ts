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
import { toHex, toNumbers } from './bytes.js'

/** A sha-256 digest in lower-case hex. */
export type MessageId = string

export const messageIdOf = (message: Uint8Array): MessageId =>
  toHex(Hash.sha256(toNumbers(message)))
