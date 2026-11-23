/**
 * The identifier a reply or a reaction names.
 *
 * `MessageContent.replyTo` and `Reaction.reference` have always held an id the
 * library did not define, which left every host to invent one — and two hosts
 * inventing differently do not interoperate, where the rest of the envelope
 * merely costs them effort.
 *
 * Derived rather than carried: the sender does not get to choose it, so it
 * cannot collide by accident or be claimed by forgery. That idea is borrowed
 * from `draft-ietf-mimi-content`; the construction is not. MIMI (§3.3) hashes
 * the content envelope together with a mandatory per-message random salt and
 * the sender and room URIs, and prefixes a hash identifier. We have no URI for
 * an identity or a group and the envelope carries no salt, so ids derived here
 * and ids derived there cannot agree. This is not a step toward MIMI interop
 * and should not be read as one — that would mean adopting their content
 * format, at which point the ids change anyway.
 *
 * The preimage is the MLS application message — one ciphertext, broadcast
 * unchanged to every member, unique per message because MLS framing is. That
 * uniqueness is free here and is exactly what MIMI needs its salt for: a
 * plaintext envelope carrying no nonce hashes the same for two identical
 * messages. Sender and recipients therefore hash exactly the same bytes
 * without agreeing on a canonical JSON form, which is the usual way a scheme
 * like this goes wrong.
 *
 * Because the preimage is the ciphertext, the id belongs to one encryption
 * rather than to the message as a thing a person sent. Re-sending the same
 * bytes — what `retryDelivery` does — keeps it. Encrypting the same text a
 * second time does not, so a host that ever re-encrypts a stored backlog into
 * a later epoch has to carry the ids it stored rather than recompute them, or
 * every `replyTo` and reaction `reference` pointing into that backlog stops
 * resolving.
 *
 * `Hash.sha256` rather than `crypto.subtle.digest`: it is pure JavaScript, so
 * this works on a React Native runtime whose WebCrypto is partial.
 */
import { Hash } from '@bsv/sdk'
import { toHex } from './bytes.js'

/**
 * Derive the id of an MLS application message: a sha-256 digest in lower-case
 * hex.
 *
 * Public and deterministic, so it is an identifier rather than a capability:
 * anyone holding the ciphertext can compute it, and holding one proves
 * nothing. Nothing may turn on knowing an id — authorise on group membership
 * and the MLS sender, which is what the framing already authenticates.
 */
export const messageIdOf = (message: Uint8Array): string =>
  // `Hash.sha256` takes a `Uint8Array` as it stands. Converting to a plain
  // array first allocated one JS number per byte on a path that runs for every
  // message sent and every message received.
  toHex(Hash.sha256(message))
