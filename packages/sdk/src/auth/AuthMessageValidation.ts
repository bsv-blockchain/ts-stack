import PublicKey from '../primitives/PublicKey.js'
import { toArray } from '../primitives/utils.js'
import type { AuthMessage, AuthMessageValidationOptions, RequestedCertificateSet } from './types.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'
import { base64ToBytes } from '../wallet/WalletByteEncoding.js'

export const MAX_AUTH_MESSAGE_BYTES = 16 * 1024 * 1024
export const MAX_AUTH_MESSAGE_DEPTH = 64
export const MAX_AUTH_MESSAGE_NODES = 100_000
const MAX_AUTH_SIGNATURE_BYTES = 1_024
const MAX_CERTIFICATES = 100
const MAX_CERTIFICATE_TYPES = 100
const MAX_CERTIFICATE_FIELDS = 100
const MAX_CERTIFICATE_FIELD_BYTES = 50

function byteLength(value: string): number {
  if (value.length > MAX_AUTH_MESSAGE_BYTES) return MAX_AUTH_MESSAGE_BYTES + 1
  return toArray(value, 'utf8').length
}

function isDenseByteArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return false
    }
  }
  return true
}

export function assertAuthByteArray(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is number[] {
  if (!isDenseByteArray(value) || (!allowEmpty && value.length === 0) || value.length > maxBytes) {
    throw new Error(`${name} must be a dense byte array of at most ${maxBytes} bytes.`)
  }
}

/** Validate and copy a byte array before retaining it across an asynchronous trust boundary. */
export function copyAuthByteArray(
  value: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false
): number[] {
  assertAuthByteArray(value, name, maxBytes, allowEmpty)
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index++) {
    copy[index] = Object.getOwnPropertyDescriptor(value, index)!.value
  }
  return copy
}

function assertCanonicalBase64(
  value: unknown,
  name: string,
  decodedBytes: number
): asserts value is string {
  let decoded: number[]
  try {
    if (typeof value !== 'string' || value.length > 128) throw new Error()
    decoded = base64ToBytes(value)
  } catch {
    throw new Error(`${name} must be canonical base64.`)
  }
  if (decoded.length !== decodedBytes) {
    throw new Error(`${name} must encode exactly ${decodedBytes} bytes.`)
  }
}

export function assertAuthIdentityKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/u.test(value)) {
    throw new Error('Authentication identityKey must be a canonical compressed public key.')
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) throw new Error('non-canonical key')
  } catch {
    throw new Error('Authentication identityKey must be a valid compressed public key.')
  }
}

/**
 * Validate the optional routing target accepted by {@link Peer.toPeer}.
 *
 * Most callers route by a peer identity key. Server transports may instead
 * route a response through the exact 48-byte session nonce that arrived with
 * the authenticated request, avoiding an identity-wide session race.
 */
export function assertAuthPeerTarget(value: unknown): asserts value is string {
  if (typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/u.test(value)) {
    assertAuthIdentityKey(value)
    return
  }
  assertCanonicalBase64(value, 'Authentication peer target session nonce', 48)
}

export function assertRequestedCertificateSet(
  value: unknown
): asserts value is RequestedCertificateSet {
  assertBoundedAuthData(value)
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('requestedCertificates must be an object.')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('requestedCertificates must be a plain object.')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.certifiers) || record.certifiers.length > MAX_CERTIFICATES) {
    throw new Error('requestedCertificates.certifiers exceeds its limit.')
  }
  const uniqueCertifiers = new Set<string>()
  for (const certifier of record.certifiers) {
    assertAuthIdentityKey(certifier)
    if (uniqueCertifiers.has(certifier)) {
      throw new Error('requestedCertificates.certifiers must be unique.')
    }
    uniqueCertifiers.add(certifier)
  }

  const types = record.types
  if (types == null || typeof types !== 'object' || Array.isArray(types)) {
    throw new Error('requestedCertificates.types must be an object.')
  }
  const typesPrototype = Object.getPrototypeOf(types)
  if (typesPrototype !== Object.prototype && typesPrototype !== null) {
    throw new Error('requestedCertificates.types must be a plain object.')
  }
  const entries = Object.entries(types)
  if (entries.length > MAX_CERTIFICATE_TYPES) {
    throw new Error('requestedCertificates.types exceeds its limit.')
  }
  for (const [type, fields] of entries) {
    if (isUnsafeRecordKey(type)) throw new Error('Unsafe requested certificate type key.')
    assertCanonicalBase64(type, 'certificate type', 32)
    if (!Array.isArray(fields) || fields.length > MAX_CERTIFICATE_FIELDS) {
      throw new Error('Requested certificate fields exceed their limit.')
    }
    const unique = new Set<string>()
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]
      if (
        !Object.hasOwn(fields, index) ||
        typeof field !== 'string' ||
        field.length === 0 ||
        byteLength(field) > MAX_CERTIFICATE_FIELD_BYTES ||
        isUnsafeRecordKey(field) ||
        unique.has(field)
      ) {
        throw new Error('Requested certificate field names must be unique safe strings.')
      }
      unique.add(field)
    }
  }
}

function walkAuthData<T>(value: T, snapshot: boolean, maxGeneralPayloadBytes?: number | null): T {
  const seen = new WeakSet<object>()
  const pending: Array<{
    value: unknown
    depth: number
    parent?: object
    key?: PropertyKey
  }> = [{ value, depth: 0 }]
  let result: unknown = value
  let bytes = 0
  let nodes = 0

  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_AUTH_MESSAGE_NODES || current.depth > MAX_AUTH_MESSAGE_DEPTH) {
      throw new Error('Authentication message structure exceeds its limit.')
    }
    const candidate = current.value
    const retain = (retained: unknown): void => {
      if (!snapshot) return
      if (current.parent === undefined) result = retained
      else Reflect.set(current.parent, current.key!, retained)
    }
    if (candidate == null || typeof candidate === 'boolean' || candidate === undefined) {
      bytes += 4
      retain(candidate)
    } else if (typeof candidate === 'string') {
      bytes += byteLength(candidate) + 2
      retain(candidate)
    } else if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw new Error('Authentication messages require finite numbers.')
      bytes += 24
      retain(candidate)
    } else if (typeof candidate === 'object') {
      if (seen.has(candidate)) throw new Error('Authentication messages must not contain cycles.')
      seen.add(candidate)
      if (Array.isArray(candidate)) {
        const separatePayload =
          maxGeneralPayloadBytes !== undefined && current.depth === 1 && current.key === 'payload'
        const maxArrayBytes = separatePayload
          ? (maxGeneralPayloadBytes ?? Number.MAX_SAFE_INTEGER)
          : MAX_AUTH_MESSAGE_BYTES
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length')
        const length = lengthDescriptor?.value
        if (!Number.isSafeInteger(length) || length < 0 || length > maxArrayBytes) {
          throw new Error('Authentication message array exceeds its limit.')
        }
        const descriptors = Array.from({ length }, (_, index) =>
          Object.getOwnPropertyDescriptor(candidate, index)
        )
        if (descriptors.some(descriptor => descriptor == null || !('value' in descriptor))) {
          throw new Error('Authentication messages must not contain sparse arrays.')
        }
        const denseBytes = descriptors.every(
          descriptor =>
            Number.isInteger(descriptor!.value) &&
            descriptor!.value >= 0 &&
            descriptor!.value <= 255
        )
        if (denseBytes) {
          // JSON uses at most three digits and a comma for each byte.
          if (!separatePayload) bytes += length * 4 + 2
          if (snapshot) {
            retain(descriptors.map(descriptor => descriptor!.value))
          }
        } else {
          const copy = snapshot ? Array.from({ length }, () => undefined as unknown) : undefined
          retain(copy)
          for (let index = length - 1; index >= 0; index--) {
            pending.push({
              value: descriptors[index]!.value,
              depth: current.depth + 1,
              parent: copy,
              key: index
            })
          }
        }
      } else {
        const keys = Reflect.ownKeys(candidate)
        const copy = snapshot ? (Object.create(null) as Record<PropertyKey, unknown>) : undefined
        retain(copy)
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]
          if (typeof key !== 'string' || isUnsafeRecordKey(key)) {
            throw new Error('Authentication messages contain an unsafe property key.')
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
          if (descriptor == null || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('Authentication messages must not contain accessors.')
          }
          bytes += byteLength(key) + 3
          pending.push({
            value: descriptor.value,
            depth: current.depth + 1,
            parent: copy,
            key
          })
        }
      }
    } else {
      throw new Error('Authentication messages contain an unsupported value.')
    }
    if (bytes > MAX_AUTH_MESSAGE_BYTES) {
      throw new Error('Authentication message exceeds the byte limit.')
    }
  }
  return result as T
}

export function assertBoundedAuthData(value: unknown): void {
  walkAuthData(value, false)
}

/**
 * Validate and copy authentication data into owned arrays and null-prototype records.
 * Descriptor-driven copying ensures only values validated during this traversal are retained.
 */
export function snapshotBoundedAuthData<T>(value: T): T {
  return walkAuthData(value, true)
}

function assertValidAuthMessageShape(
  value: unknown,
  maxGeneralPayloadBytes?: number | null
): asserts value is AuthMessage {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid authentication message.')
  }
  const message = value as Partial<AuthMessage>
  if (message.version !== '0.1') {
    throw new Error(
      `Invalid or unsupported message auth version! Received: ${String(message.version)}, expected: 0.1`
    )
  }
  assertAuthIdentityKey(message.identityKey)
  if (message.requestedCertificates !== undefined) {
    assertRequestedCertificateSet(message.requestedCertificates)
  }
  if (message.certificates !== undefined) {
    if (!Array.isArray(message.certificates) || message.certificates.length > MAX_CERTIFICATES) {
      throw new Error('Authentication certificates exceed their limit.')
    }
  }

  switch (message.messageType) {
    case 'initialRequest':
      assertCanonicalBase64(message.initialNonce, 'initialRequest.initialNonce', 48)
      break
    case 'initialResponse':
      assertCanonicalBase64(message.initialNonce, 'initialResponse.initialNonce', 48)
      assertCanonicalBase64(message.yourNonce, 'initialResponse.yourNonce', 48)
      assertAuthByteArray(message.signature, 'initialResponse.signature', MAX_AUTH_SIGNATURE_BYTES)
      break
    case 'certificateRequest':
      assertCanonicalBase64(message.nonce, 'certificateRequest.nonce', 32)
      assertCanonicalBase64(message.initialNonce, 'certificateRequest.initialNonce', 48)
      assertCanonicalBase64(message.yourNonce, 'certificateRequest.yourNonce', 48)
      assertRequestedCertificateSet(message.requestedCertificates)
      assertAuthByteArray(
        message.signature,
        'certificateRequest.signature',
        MAX_AUTH_SIGNATURE_BYTES
      )
      break
    case 'certificateResponse':
      assertCanonicalBase64(message.nonce, 'certificateResponse.nonce', 32)
      assertCanonicalBase64(message.initialNonce, 'certificateResponse.initialNonce', 48)
      assertCanonicalBase64(message.yourNonce, 'certificateResponse.yourNonce', 48)
      if (!Array.isArray(message.certificates)) {
        throw new Error('certificateResponse.certificates must be an array.')
      }
      assertAuthByteArray(
        message.signature,
        'certificateResponse.signature',
        MAX_AUTH_SIGNATURE_BYTES
      )
      break
    case 'general':
      assertCanonicalBase64(message.nonce, 'general.nonce', 32)
      assertCanonicalBase64(message.yourNonce, 'general.yourNonce', 48)
      assertAuthByteArray(
        message.payload,
        'general.payload',
        maxGeneralPayloadBytes === null
          ? Number.MAX_SAFE_INTEGER
          : (maxGeneralPayloadBytes ?? MAX_AUTH_MESSAGE_BYTES),
        true
      )
      assertAuthByteArray(message.signature, 'general.signature', MAX_AUTH_SIGNATURE_BYTES)
      break
    default:
      throw new Error(`Unknown authentication message type: ${String(message.messageType)}`)
  }
}

/** Validate an untrusted BRC-103 message before any wallet or session work. */
export function assertValidAuthMessage(value: unknown): asserts value is AuthMessage {
  assertValidAuthMessageShape(snapshotBoundedAuthData(value))
}

export function assertGeneralPayloadByteLimit(value: number | null | undefined): void {
  if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError('maxGeneralPayloadBytes must be null or a positive safe integer.')
  }
}

/** Validate and own an untrusted BRC-103 message using locally selected payload policy. */
export function snapshotAuthMessage(
  value: unknown,
  options: AuthMessageValidationOptions = {}
): AuthMessage {
  const maxGeneralPayloadBytes = options.maxGeneralPayloadBytes
  assertGeneralPayloadByteLimit(maxGeneralPayloadBytes)
  const isGeneral =
    maxGeneralPayloadBytes !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    Object.getOwnPropertyDescriptor(value, 'messageType')?.value === 'general'
  const payloadBudget = isGeneral ? maxGeneralPayloadBytes : undefined
  const snapshot = walkAuthData(value, true, payloadBudget)
  assertValidAuthMessageShape(snapshot, payloadBudget)
  // A proxy cannot change message type while descriptors are copied and thereby
  // transfer the general-payload policy to a handshake or certificate message.
  if (payloadBudget !== undefined && snapshot.messageType !== 'general') {
    assertBoundedAuthData(snapshot)
  }
  return snapshot
}
