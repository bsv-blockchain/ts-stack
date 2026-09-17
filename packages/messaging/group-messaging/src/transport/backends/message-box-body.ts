import { GroupMessagingError } from '../../errors.js'

export const BODY_VERSION = 1

/**
 * A body that parsed but is not one of ours, however many times it is
 * redelivered — a wrong version, a missing payload, base64 that is not base64.
 *
 * Permanent by construction: the bytes are intact and they still do not make an
 * envelope, so the backend acknowledges it rather than retrying.
 */
export class MalformedBodyError extends GroupMessagingError {
  override name = 'MalformedBodyError'
}

/**
 * A body that never became JSON at all.
 *
 * Distinct from {@link MalformedBodyError} because the likeliest cause is not a
 * bad message: `@bsv/message-box-client` catches *any* failure of
 * `walletClient.decrypt` and replaces the body with the plain string
 * `[Error: Failed to decrypt or parse message]`. A locked wallet, a declined
 * BRC-100 prompt or one substrate blip therefore arrives here, and
 * acknowledging it would delete a message the next poll could have read — a
 * Commit lost that way wedges the member's group forever. So this is
 * retryable, and the delivery attempt cap is what bounds a genuinely corrupt
 * body.
 *
 * Two error classes rather than one error carrying a flag: the caller's
 * question is "may I acknowledge this?", and a type answers it at the catch
 * site without anyone having to remember to read a field.
 */
export class UnparsableBodyError extends GroupMessagingError {
  override name = 'UnparsableBodyError'
}

/**
 * MessageBox carries a string body on the wire, and MLS payloads are bytes.
 *
 * Base64 inside a versioned JSON object: Nexus sends `JSON.stringify(token)` to
 * this host, so a JSON string is the established shape, and the version field
 * costs one key now against a format change later.
 */
export const encodeBody = (payload: Uint8Array): string =>
  JSON.stringify({ v: BODY_VERSION, payload: toBase64(payload) })

/**
 * `@bsv/message-box-client` runs every inbound body through its own
 * `tryParse` (JSON.parse, falling back to the raw string on failure) before
 * handing it to `listMessages` — see `MessageBoxClient.js`'s `tryParse`
 * (around line 1533) and its call sites on the decrypted path (around line
 * 1009) and the unencrypted one (around line 1502). Since `encodeBody`'s
 * output is always valid JSON, the client always parses it, so this backend
 * receives an object here in practice, not the string it sent. Accepting
 * both means parsing once when we get a string, then validating the same
 * envelope shape regardless of which form arrived.
 *
 * Throws {@link UnparsableBodyError} when the body is not JSON — retry it —
 * and {@link MalformedBodyError} when it is JSON that is not our envelope —
 * do not.
 */
export const decodeBody = (body: string | Record<string, unknown>): Uint8Array => {
  let parsed: unknown
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch (cause) {
      throw new UnparsableBodyError('MessageBox body is not valid JSON', { cause })
    }
  } else {
    parsed = body
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MalformedBodyError('MessageBox body is not an object')
  }
  const envelope = parsed as { v?: unknown; payload?: unknown }
  if (envelope.v !== BODY_VERSION) {
    throw new MalformedBodyError(`Unsupported MessageBox body version ${String(envelope.v)}`)
  }
  if (typeof envelope.payload !== 'string') {
    throw new MalformedBodyError('MessageBox body carries no payload')
  }
  return fromBase64(envelope.payload)
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  return btoa(binary)
}

const fromBase64 = (value: string): Uint8Array => {
  let binary: string
  try {
    binary = atob(value)
  } catch (cause) {
    throw new MalformedBodyError('MessageBox payload is not base64', { cause })
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.codePointAt(index)!
  return bytes
}
