import { Writer, toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { Random, PublicKey, type WalletProtocol } from '@bsv/sdk'
import {
  DEFAULT_PROTOCOL,
  DEFAULT_WINDOW_MS,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_BODY_BYTES
} from './constants.js'
import type {
  AuthProof,
  AuthProofOptions,
  AuthSigData,
  CreateAuthProofArgs,
  RequestBody,
  VerifyAuthProofArgs,
  VerifyAuthProofResult
} from './types.js'

interface ResolvedOptions {
  protocol: WalletProtocol
  windowMs: number
  clockSkewMs: number
  maxBodyBytes: number
}

const MAX_ACTION_BYTES = 256
const MAX_SIGNATURE_BYTES = 1_024

function ownDataValue(value: object, name: string): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined
}

function exactBytes(value: unknown, maxBytes: number): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxBytes) return undefined
  const copy = Array.from({ length: value.length }, () => 0)
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index)
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        !Number.isInteger(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > 255
      ) {
        return undefined
      }
      copy[index] = descriptor.value
    }
  } catch {
    return undefined
  }
  return copy
}

function isCompressedPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/u.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value
  } catch {
    return false
  }
}

function isCanonicalNonce(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return false
  }
  try {
    const decoded = toArray(value, 'base64')
    return decoded.length === 32 && toBase64(decoded) === value
  } catch {
    return false
  }
}

function isValidAction(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ACTION_BYTES &&
    toArray(value, 'utf8').length <= MAX_ACTION_BYTES &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
}

function validateProtocol(protocol: unknown): WalletProtocol {
  let securityLevel: unknown
  let protocolName: unknown
  try {
    if (!Array.isArray(protocol) || protocol.length !== 2) {
      throw new TypeError('protocol must be a valid wallet protocol tuple')
    }
    securityLevel = ownDataValue(protocol, '0')
    protocolName = ownDataValue(protocol, '1')
  } catch {
    throw new TypeError('protocol must be a valid wallet protocol tuple')
  }
  if (
    (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) ||
    typeof protocolName !== 'string' ||
    toArray(protocolName, 'utf8').length < 5 ||
    toArray(protocolName, 'utf8').length > 400 ||
    protocolName !== protocolName.trim() ||
    protocolName.includes('  ') ||
    protocolName.toLowerCase().endsWith(' protocol') ||
    !/^[A-Za-z0-9 ]+$/u.test(protocolName)
  ) {
    throw new TypeError('protocol must use a valid wallet security level and protocol name')
  }
  return [securityLevel, protocolName]
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function utf8ByteLength(value: string): number {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) length += 1
    else if (code <= 0x7ff) length += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4
        index += 1
      } else {
        length += 3
      }
    } else length += 3
  }
  return length
}

function assertBoundedJsonBody(value: unknown, maxBodyBytes: number): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > 100_000 || current.depth > 64) {
      throw new RangeError('Authentication proof body exceeds structural limits')
    }
    const candidate = current.value
    if (candidate === null) {
      bytes += 4
      continue
    }
    if (typeof candidate === 'string') {
      bytes += utf8ByteLength(candidate)
      if (bytes > maxBodyBytes) {
        throw new RangeError('Authentication proof body exceeds maxBodyBytes')
      }
      continue
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new TypeError('Authentication proof body must contain canonical JSON numbers')
      }
      bytes += 32
      continue
    }
    if (typeof candidate === 'boolean') {
      bytes += 5
      continue
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('Authentication proof body must contain JSON-compatible plain data')
    }
    if (seen.has(candidate)) {
      throw new TypeError('Authentication proof body must not contain cycles')
    }
    seen.add(candidate)
    const prototype = Object.getPrototypeOf(candidate)
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Authentication proof body must contain JSON-compatible plain data')
    }
    if (Array.isArray(candidate) && candidate.length > 100_000) {
      throw new RangeError('Authentication proof body exceeds structural limits')
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError('Authentication proof body must not contain accessors')
      }
      bytes += utf8ByteLength(key)
      pending.push({ value: descriptor.value, depth: current.depth + 1 })
    }
    if (bytes > maxBodyBytes) {
      throw new RangeError('Authentication proof body exceeds maxBodyBytes')
    }
  }
}

function resolveOptions(options: AuthProofOptions = {}): ResolvedOptions {
  const protocol = validateProtocol(options.protocol ?? DEFAULT_PROTOCOL)
  const windowMs = positiveSafeInteger(options.windowMs ?? DEFAULT_WINDOW_MS, 'windowMs')
  const clockSkewMs = nonNegativeSafeInteger(
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
    'clockSkewMs'
  )
  if (!Number.isSafeInteger(windowMs + clockSkewMs)) {
    throw new RangeError('windowMs plus clockSkewMs must be a safe integer')
  }
  return {
    protocol,
    windowMs,
    clockSkewMs,
    maxBodyBytes: positiveSafeInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      'maxBodyBytes'
    )
  }
}

function snapshotAuthSigData(value: unknown): AuthSigData | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const action = ownDataValue(value, 'action')
    const identityKey = ownDataValue(value, 'identityKey')
    const expiresAt = ownDataValue(value, 'expiresAt')
    const nonce = ownDataValue(value, 'nonce')
    if (
      !isValidAction(action) ||
      !isCompressedPublicKey(identityKey) ||
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) < 0 ||
      !isCanonicalNonce(nonce)
    ) {
      return undefined
    }
    return { action, identityKey, expiresAt: expiresAt as number, nonce }
  } catch {
    return undefined
  }
}

function snapshotAuthProof(value: unknown): AuthProof | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const data = snapshotAuthSigData(ownDataValue(value, 'data'))
    const signature = exactBytes(ownDataValue(value, 'signature'), MAX_SIGNATURE_BYTES)
    return data === undefined || signature === undefined ? undefined : { data, signature }
  } catch {
    return undefined
  }
}

function serializeCanonicalAuthSigData(data: AuthSigData): number[] {
  const canonical = [data.action, data.identityKey, String(data.expiresAt), data.nonce].join('\n')
  return toArray(canonical, 'utf8')
}

/** Canonical bytes both sides hash. Fixed field order; '\n' is a safe delimiter. */
export function serializeAuthSigData(data: AuthSigData): number[] {
  const snapshot = snapshotAuthSigData(data)
  if (snapshot === undefined) {
    throw new TypeError('Authentication signature data must contain canonical own data fields')
  }
  return serializeCanonicalAuthSigData(snapshot)
}

/**
 * Reduce a request body to the exact bytes bound into the signature, so the
 * client can pass the value it sends and the verifier the raw body it received:
 * a string is UTF-8, an `ArrayBuffer` or typed array is taken as raw bytes (so
 * binary is preserved), and anything else — a plain object or any array — is
 * JSON-encoded then UTF-8.
 */
export function normalizeBody(
  body: RequestBody,
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES
): number[] {
  positiveSafeInteger(maxBodyBytes, 'maxBodyBytes')
  let normalized: number[]
  if (typeof body === 'string') normalized = toArray(body, 'utf8')
  else if (body instanceof ArrayBuffer) normalized = Array.from(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) {
    normalized = Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  } else if (typeof body !== 'string' && !(body instanceof ArrayBuffer)) {
    assertBoundedJsonBody(body, maxBodyBytes)
    normalized = toArray(JSON.stringify(body), 'utf8') // plain objects and all arrays → JSON
  }
  if (normalized!.length > maxBodyBytes) {
    throw new RangeError('Authentication proof body exceeds maxBodyBytes')
  }
  return normalized!
}

/**
 * Bytes that are signed and verified for a proof: the canonical auth fields and,
 * when the request carries a body, that body bound in too. The body is appended
 * length-prefixed (not delimited) so arbitrary binary stays unambiguous. With no
 * body the result is exactly `serializeAuthSigData(data)`, so login proofs are
 * byte-for-byte unchanged. A body-bound proof and a bodyless one never collide:
 * an empty body (length 0) still differs from "no body" (nothing appended).
 */
export function serializeSignablePayload(
  data: AuthSigData,
  body?: RequestBody,
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES
): number[] {
  const snapshot = snapshotAuthSigData(data)
  if (snapshot === undefined) {
    throw new TypeError('Authentication signature data must contain canonical own data fields')
  }
  const bytes = body === undefined ? undefined : normalizeBody(body, maxBodyBytes)
  return serializeNormalizedPayload(snapshot, bytes)
}

function serializeNormalizedPayload(data: AuthSigData, body?: number[]): number[] {
  const head = serializeCanonicalAuthSigData(data)
  if (body === undefined) return head
  const writer = new Writer()
  writer.write(head)
  writer.writeVarIntNum(body.length)
  writer.write(body)
  return writer.toArray()
}

/** Builds the per-request signable data: fresh expiry + strong random nonce. */
export function createAuthSigData(
  action: string,
  identityKey: string,
  options?: AuthProofOptions,
  now: number = Date.now()
): AuthSigData {
  const { windowMs } = resolveOptions(options)
  if (
    !isValidAction(action) ||
    !isCompressedPublicKey(identityKey) ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new TypeError('action, identityKey, and now must be canonical authentication fields')
  }
  if (!Number.isSafeInteger(now + windowMs)) {
    throw new RangeError('Authentication proof expiry exceeds the safe integer range')
  }
  return {
    action,
    identityKey,
    expiresAt: now + windowMs,
    nonce: toBase64(Random(32))
  }
}

/** Pure check of shape, action, and freshness. Signature + single-use checked separately. */
export function checkAuthSigData(
  data: AuthSigData | undefined | null,
  expectedAction: string,
  now: number,
  options?: AuthProofOptions
): { valid: boolean; error?: string } {
  const resolved = resolveOptions(options)
  const snapshot = snapshotAuthSigData(data)
  if (snapshot === undefined) {
    return { valid: false, error: 'Malformed proof' }
  }
  return checkCanonicalAuthSigData(snapshot, expectedAction, now, resolved)
}

function checkCanonicalAuthSigData(
  data: AuthSigData,
  expectedAction: string,
  now: number,
  options: ResolvedOptions
): { valid: boolean; error?: string } {
  const { windowMs, clockSkewMs } = options
  if (!isValidAction(expectedAction) || !Number.isSafeInteger(now) || now < 0) {
    return { valid: false, error: 'Malformed proof' }
  }
  const { action, expiresAt } = data
  if (action !== expectedAction) {
    return { valid: false, error: 'Action mismatch' }
  }
  if (now >= expiresAt) {
    return { valid: false, error: 'Proof expired' }
  }
  // Reject expiry beyond the window — stops a client minting a long-lived proof.
  if (expiresAt - now > windowMs + clockSkewMs) {
    return { valid: false, error: 'Proof expiry too far in the future' }
  }
  return { valid: true }
}

/**
 * Client-side: build a signed proof authorizing `action` for this wallet.
 * `counterparty` is the verifier's identity key (e.g. your backend) that the
 * wallet signs toward — relative to the wallet, so it's a different key than the
 * server passes to verify (there the counterparty is this signer's identity).
 *
 * Pass `body` to bind a request payload (e.g. the new username for a profile
 * update) into the signature; the verifier must be given the same body. Omit it
 * for bodyless actions like login. The body is bound only — it is not stored in
 * the returned proof; send it over the wire as usual.
 */
export async function createAuthProof(args: CreateAuthProofArgs): Promise<AuthProof> {
  const { wallet, counterparty, action, body } = args
  const resolved = resolveOptions(args)
  const { protocol, maxBodyBytes } = resolved
  if (!isCompressedPublicKey(counterparty) || !isValidAction(action)) {
    throw new TypeError('counterparty and action must be canonical authentication fields')
  }
  const normalizedBody = body === undefined ? undefined : normalizeBody(body, maxBodyBytes)
  const identityResult: unknown = await wallet.getPublicKey({ identityKey: true })
  if (identityResult === null || typeof identityResult !== 'object') {
    throw new TypeError('Wallet returned a malformed identity key')
  }
  const identityKey = ownDataValue(identityResult, 'publicKey')
  if (!isCompressedPublicKey(identityKey)) {
    throw new TypeError('Wallet returned a malformed identity key')
  }
  const data = createAuthSigData(action, identityKey, resolved)

  const signatureResult: unknown = await wallet.createSignature({
    data: serializeNormalizedPayload(data, normalizedBody),
    protocolID: protocol,
    keyID: data.nonce,
    counterparty
  })
  if (signatureResult === null || typeof signatureResult !== 'object') {
    throw new TypeError('Wallet returned a malformed authentication signature')
  }
  const signature = exactBytes(ownDataValue(signatureResult, 'signature'), MAX_SIGNATURE_BYTES)
  if (signature === undefined) {
    throw new TypeError('Wallet returned a malformed authentication signature')
  }

  return { data, signature }
}

/**
 * Server-side: verify a proof. Steps: shape/action/freshness → signature →
 * single-use (via the injected `consumeNonce`). Returns the authenticated
 * identityKey on success. `now` is injectable for tests.
 *
 * If the proof was created with a `body`, pass the raw received body as `body`
 * so it is bound into the verified bytes identically; a tampered or missing body
 * then fails the signature check. Omit it for bodyless actions.
 */
export async function verifyAuthProof(args: VerifyAuthProofArgs): Promise<VerifyAuthProofResult> {
  const { wallet, proof, action: expectedAction, consumeNonce, body } = args
  const resolved = resolveOptions(args)
  const { protocol, maxBodyBytes } = resolved
  const now = args.now ?? Date.now()
  const snapshot = snapshotAuthProof(proof)
  if (snapshot === undefined) {
    return { valid: false, error: 'Malformed proof' }
  }

  const shape = checkCanonicalAuthSigData(snapshot.data, expectedAction, now, resolved)
  if (!shape.valid) {
    return { valid: false, error: shape.error }
  }

  const { identityKey, nonce, expiresAt } = snapshot.data

  // identityKey and signature come from the request; a malformed key or signature
  // can make verification throw, so treat any failure as an invalid signature.
  let signatureValid = false
  try {
    const normalizedBody = body === undefined ? undefined : normalizeBody(body, maxBodyBytes)
    const result: unknown = await wallet.verifySignature({
      data: serializeNormalizedPayload(snapshot.data, normalizedBody),
      signature: snapshot.signature,
      protocolID: protocol,
      keyID: nonce,
      counterparty: identityKey
    })
    signatureValid =
      result !== null && typeof result === 'object' && ownDataValue(result, 'valid') === true
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' }
  }

  const fresh: unknown = await consumeNonce(nonce, new Date(expiresAt))
  if (fresh !== true) {
    return { valid: false, error: 'Proof already used' }
  }

  return { valid: true, identityKey }
}
