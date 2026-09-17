import { concat } from '../bytes.js'
import { GroupMessagingError } from '../errors.js'
import { asKeyPackageBytes } from '../mls/key-package-codec.js'
import { SUPPORTED_CIPHERSUITES, type MlsCiphersuiteName } from '../types.js'
import type { Envelope } from './types.js'

export class EnvelopeError extends GroupMessagingError {
  override name = 'EnvelopeError'
}

const VERSION = 1
const KIND_BOOTSTRAP = 1
const KIND_MLS = 2

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const requireString = (obj: Record<string, unknown>, field: string): string => {
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new EnvelopeError(`Invalid ${field}: must be a non-empty string`)
  }
  return value
}

const requireStringArray = (obj: Record<string, unknown>, field: string): string[] => {
  const value = obj[field]
  if (!Array.isArray(value) || value.length === 0 || !value.every(v => typeof v === 'string')) {
    throw new EnvelopeError(`Invalid ${field}: must be a non-empty array of strings`)
  }
  return value
}

/**
 * The offered suites, narrowed to ones this library actually has.
 *
 * The result is typed `MlsCiphersuiteName[]` and reaches a consumer on
 * `inviteReceived`, which will reasonably hand element zero to
 * `keyPackages.create` — so an unchecked string here is a lie in the type, not
 * untidy data. The cap matters separately: the array is persisted verbatim on
 * the invite row, so an unbounded one is storage a stranger chose.
 */
const MAX_OFFERED_CIPHERSUITES = 16

/** Persisted on the invite and chat rows, sender-chosen, and rendered. */
const MAX_CHAT_NAME_LENGTH = 256

const optionalChatName = (header: Record<string, unknown>): string | undefined => {
  const chatName = optionalString(header, 'chatName')
  if (chatName !== undefined && chatName.length > MAX_CHAT_NAME_LENGTH) {
    throw new EnvelopeError(
      `Invalid chatName: ${chatName.length} characters, at most ${MAX_CHAT_NAME_LENGTH}`
    )
  }
  return chatName
}

const requireSupportedCiphersuites = (header: Record<string, unknown>): MlsCiphersuiteName[] => {
  const offered = requireStringArray(header, 'ciphersuites')
  if (offered.length > MAX_OFFERED_CIPHERSUITES) {
    throw new EnvelopeError(
      `Invalid ciphersuites: ${offered.length} offered, at most ${MAX_OFFERED_CIPHERSUITES}`
    )
  }
  // An offer of nothing we serve is well formed, just unserveable, so it passes
  // through empty rather than throwing. Failing the decode reported it to the
  // host as a malformed envelope, which it is not; the refusal is now a
  // `bootstrapRefused` the host can see. The peer is told nothing either way —
  // no refusal path in this library answers, and replying to a stranger would
  // make one an existence oracle.
  return offered.filter((name): name is MlsCiphersuiteName =>
    (SUPPORTED_CIPHERSUITES as readonly string[]).includes(name)
  )
}

const optionalString = (obj: Record<string, unknown>, field: string): string | undefined => {
  const value = obj[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new EnvelopeError(`Invalid ${field}: must be a string`)
  }
  return value
}

/**
 * `u8 version | u8 kind | u32 header length | header JSON | trailing binary`
 *
 * The binary tail keeps KeyPackage and Welcome bytes out of the JSON, where
 * base64 would cost a third of their size on every hop.
 */
export const encodeEnvelope = (envelope: Envelope): Uint8Array => {
  if (envelope.kind === 'mls') return frame(KIND_MLS, {}, envelope.payload)

  const message = envelope.message
  switch (message.type) {
    case 'keyPackageResponse': {
      const { keyPackage, ...header } = message
      return frame(KIND_BOOTSTRAP, header, keyPackage)
    }
    case 'welcome': {
      const { welcome, ...header } = message
      return frame(KIND_BOOTSTRAP, header, welcome)
    }
    default:
      return frame(KIND_BOOTSTRAP, message, new Uint8Array())
  }
}

export const decodeEnvelope = (bytes: Uint8Array): Envelope => {
  if (bytes.length < 6) throw new EnvelopeError('Truncated envelope header')
  if (bytes[0] !== VERSION) throw new EnvelopeError(`Unsupported envelope version ${bytes[0]}`)

  const kind = bytes[1]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = view.getUint32(2, false)
  if (6 + headerLength > bytes.length) throw new EnvelopeError('Truncated envelope header')

  const body = bytes.slice(6 + headerLength)
  if (kind === KIND_MLS) return { kind: 'mls', payload: body }
  if (kind !== KIND_BOOTSTRAP) throw new EnvelopeError(`Unknown envelope kind ${kind}`)

  let header: Record<string, unknown>
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(6, 6 + headerLength))) as Record<
      string,
      unknown
    >
  } catch (cause) {
    throw new EnvelopeError('Envelope header is not valid JSON', { cause })
  }

  switch (header['type']) {
    case 'keyPackageRequest': {
      const requestId = requireString(header, 'requestId')
      const ciphersuites = requireSupportedCiphersuites(header)
      const chatName = optionalChatName(header)
      return {
        kind: 'bootstrap',
        message: {
          type: 'keyPackageRequest',
          requestId,
          ciphersuites,
          ...(chatName !== undefined && { chatName })
        }
      }
    }
    case 'keyPackageDecline': {
      const requestId = requireString(header, 'requestId')
      return { kind: 'bootstrap', message: { type: 'keyPackageDecline', requestId } }
    }
    case 'keyPackageResponse': {
      const requestId = requireString(header, 'requestId')
      return {
        kind: 'bootstrap',
        message: { type: 'keyPackageResponse', requestId, keyPackage: asKeyPackageBytes(body) }
      }
    }
    case 'welcome': {
      const requestId = requireString(header, 'requestId')
      const chatName = optionalChatName(header)
      return {
        kind: 'bootstrap',
        message: {
          type: 'welcome',
          requestId,
          welcome: body,
          ...(chatName !== undefined && { chatName })
        }
      }
    }
    default:
      throw new EnvelopeError(`Unknown bootstrap message type ${String(header['type'])}`)
  }
}

const frame = (kind: number, header: object, body: Uint8Array): Uint8Array => {
  const headerBytes = encoder.encode(JSON.stringify(header))
  const prefix = new Uint8Array(6)
  prefix[0] = VERSION
  prefix[1] = kind
  new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).setUint32(
    2,
    headerBytes.length,
    false
  )
  return concat(prefix, headerBytes, body)
}
