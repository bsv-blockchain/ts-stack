import { PublicKey, SymmetricKey } from '@bsv/sdk/primitives'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import {
  assertBoundedString,
  assertDuration,
  defineOwn,
  getOwnDataProperties,
  hasOwn,
  snapshotBytes,
  snapshotJsonObject,
  snapshotJsonValue
} from '../validation.js'
import {
  BRC52_LIMITS,
  decodeBRC52Base64,
  exportBRC52Envelope,
  parseBRC52Envelope,
  validateBRC52Disclosure,
  verifyBRC52CertificateBinary
} from './envelope.js'
import type { BRC52StatusResult } from './status.js'
import type { BRC52CredentialGraph } from './types.js'

type SourceCertificate = ReturnType<typeof verifyBRC52CertificateBinary>
type Envelope = ReturnType<typeof exportBRC52Envelope>

const MAX_PAYLOAD_BYTES = BRC52_LIMITS.jsonBytes
const MAX_CONTEXT_BYTES = 2_048
const MAX_REQUEST_AGE_MS = 300_000

export interface BRC52DisclosureAuthorization {
  certificateBinary: string
  subject: string
  verifier: string
  purpose: string
  fieldsToReveal: readonly string[]
}

export interface ProduceBRC52DisclosureOptions {
  certificateBinary: Uint8Array | number[]
  wallet: Pick<WalletInterface, 'getPublicKey' | 'proveCertificate'>
  verifier: string
  purpose: string
  fieldsToReveal: readonly string[]
  /** Obtain informed user permission for this exact recipient, purpose and field selection. */
  authorize: (request: BRC52DisclosureAuthorization) => Promise<boolean>
}

/**
 * Uses the wallet's BRC-100 certificate store and proveCertificate permission model.
 * The wallet must validate its applicable stored master keyring; this adapter never
 * exports master keys or creates or signs a certificate. Send the entire returned
 * envelope within the authenticated application payload of BRC-103/BRC-104.
 */
export async function produceBRC52Disclosure(
  options: ProduceBRC52DisclosureOptions
): Promise<Envelope> {
  const binary = snapshotBytes(
    options.certificateBinary,
    'certificateBinary',
    BRC52_LIMITS.certificateBytes
  )
  const source = verifyBRC52CertificateBinary(binary)
  const envelope = exportBRC52Envelope(binary)
  const verifier = identityKey(options.verifier, 'verifier')
  const purpose = contextString(options.purpose, 'purpose')
  const fieldsToReveal = selectedFields(options.fieldsToReveal, source.fields)
  const permission = Object.freeze({
    certificateBinary: envelope.certificateBinary,
    subject: source.subject,
    verifier,
    purpose,
    fieldsToReveal: Object.freeze([...fieldsToReveal])
  })
  if ((await options.authorize(permission)) !== true)
    throw new Error('Disclosure authorization denied')
  const identity = await options.wallet.getPublicKey({ identityKey: true })
  if (identityKey(identity.publicKey, 'wallet identity') !== source.subject) {
    throw new Error('Wallet identity does not match certificate subject')
  }
  const result = await options.wallet.proveCertificate({
    certificate: walletCertificate(source),
    verifier,
    fieldsToReveal: [...fieldsToReveal]
  })
  if (result.verifier !== undefined && result.verifier !== verifier) {
    throw new Error('Wallet returned a different verifier')
  }
  if (result.certificate !== undefined) {
    if (
      !sameJson(
        snapshotJsonObject(result.certificate, 'wallet certificate'),
        walletCertificate(source)
      )
    ) {
      throw new Error('Wallet returned a different certificate')
    }
  }
  const disclosure = validateBRC52Disclosure(
    { subject: source.subject, verifier, keyring: result.keyringForVerifier },
    source
  )
  const names = Object.keys(disclosure.keyring)
  if (
    names.length !== fieldsToReveal.length ||
    fieldsToReveal.some(name => !hasOwn(disclosure.keyring, name))
  )
    throw new Error('Wallet keyring does not match authorized field selection')
  return { ...envelope, disclosure }
}

export interface BRC52AuthenticatedRequest {
  /** Values must come from the locally trusted authenticated dispatcher, never incoming metadata. */
  peer: string
  receivingVerifier: string
  payload: Uint8Array
  operation: string
  /** Signature-covered purpose/application context, bound to the intended operation. */
  purpose: string
  nonce: string
  authenticatedAt: number
  sessionId: string
}

export interface BRC52AuthenticationPort {
  /**
   * Must independently verify a fresh BRC-103 request (BRC-104 for HTTP), including
   * complete exact application payload and signed operation/routing and purpose.
   * Throws on failure. Returning caller-asserted metadata is not authentication.
   * This integration port defines no alternate wire format or presentation proof.
   */
  authenticate: (request: {
    payload: Uint8Array
    operation: string
    purpose: string
    receivingVerifier: string
  }) => Promise<BRC52AuthenticatedRequest>
}

export interface BRC52NonceStore {
  /** Atomically reserve an authenticated nonce; reject replays and fail closed at capacity. */
  consume: (
    scope: string,
    nonce: string,
    expiresAt: number,
    now: number
  ) => boolean | Promise<boolean>
}

/** Process-local bounded replay protection; use a shared atomic store across workers/restarts. */
export class BRC52MemoryNonceStore implements BRC52NonceStore {
  private readonly entries = new Map<string, number>()
  private lastNow = 0

  constructor(private readonly capacity = 10_000) {
    assertDuration(capacity, 'nonce capacity', 100_000)
    if (capacity === 0) throw new TypeError('nonce capacity must be positive')
  }

  consume(scope: string, nonce: string, expiresAt: number, now: number): boolean {
    contextString(scope, 'nonce scope', 8_192)
    contextString(nonce, 'nonce')
    assertDuration(now, 'now', Number.MAX_SAFE_INTEGER)
    assertDuration(expiresAt, 'nonce expiry', Number.MAX_SAFE_INTEGER)
    if (now < this.lastNow || expiresAt < now) return false
    this.lastNow = now
    for (const [key, expiry] of this.entries) {
      if (expiry < now) this.entries.delete(key)
    }
    const key = JSON.stringify([scope, nonce])
    if (this.entries.has(key) || this.entries.size >= this.capacity) return false
    this.entries.set(key, expiresAt)
    return true
  }
}

export interface ReceiveBRC52DisclosureOptions {
  inputData: string | Uint8Array
  wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>
  receivingVerifier: string
  operation: string
  purpose: string
  authentication: BRC52AuthenticationPort
  nonceStore: BRC52NonceStore
  /** Epoch milliseconds. Set from a locally trusted clock. */
  now: () => number
  /** 1..300000 milliseconds; no future timestamps are accepted. */
  maxRequestAgeMs: number
  /**
   * Apply issuer/schema trust, purpose and field permissions, plus status freshness
   * and privacy policy. Throw or deny when reliance is insufficient. The returned
   * status is separate application evidence, never an issuer-secured graph claim.
   */
  assessReliance: (request: {
    certificate: SourceCertificate
    authenticatedRequest: BRC52AuthenticatedRequest
    fieldsToReveal: readonly string[]
  }) => Promise<{ authorized: boolean; status: BRC52StatusResult }>
}

export interface BRC52DisclosureResult {
  verifiedDocument: BRC52CredentialGraph
  disclosedFields: Record<string, string>
  source: {
    certificateBinary: string
    subject: string
    certifier: string
    revocationOutpoint: string
  }
  recipient: string
  authenticatedRequest: Omit<BRC52AuthenticatedRequest, 'payload'>
  status: BRC52StatusResult
}

/** Authenticate, authorize and decrypt atomically: any failure rejects without returning partial plaintext. */
export async function receiveBRC52Disclosure(
  options: ReceiveBRC52DisclosureOptions
): Promise<BRC52DisclosureResult> {
  const payload = inputBytes(options.inputData)
  const { envelope, source } = parseBRC52Envelope(payload)
  const disclosure = envelope.disclosure
  if (disclosure === undefined) throw new Error('Disclosure envelope required')
  const verifier = identityKey(options.receivingVerifier, 'receiving verifier')
  if (disclosure.subject !== source.subject || disclosure.verifier !== verifier) {
    throw new Error('Disclosure subject or receiving verifier mismatch')
  }
  const keyring = disclosure.keyring
  const operation = contextString(options.operation, 'operation')
  const purpose = contextString(options.purpose, 'purpose')
  assertDuration(options.maxRequestAgeMs, 'maxRequestAgeMs', MAX_REQUEST_AGE_MS)
  if (options.maxRequestAgeMs === 0) throw new TypeError('maxRequestAgeMs must be positive')
  const maxRequestAgeMs = options.maxRequestAgeMs
  const receipt = await options.authentication.authenticate({
    payload: payload.slice(),
    operation,
    purpose,
    receivingVerifier: verifier
  })
  const session = validateReceipt(receipt, payload, source.subject, verifier, operation, purpose)
  const now = options.now()
  assertDuration(now, 'now', Number.MAX_SAFE_INTEGER)
  if (session.authenticatedAt > now || now - session.authenticatedAt > maxRequestAgeMs) {
    throw new Error('Authenticated request is stale or future dated')
  }
  const expiry = session.authenticatedAt + maxRequestAgeMs
  assertDuration(expiry, 'nonce expiry', Number.MAX_SAFE_INTEGER)
  // Nonces are unique per authenticated peer/recipient across sessions and routes.
  const scope = JSON.stringify([source.subject, verifier])
  if (!(await options.nonceStore.consume(scope, session.nonce, expiry, now))) {
    throw new Error('Authenticated request nonce repeated or replay store unavailable')
  }
  const assessment = await options.assessReliance({
    certificate: verifyBRC52CertificateBinary(source.certificateBinary),
    authenticatedRequest: { ...session, payload: payload.slice() },
    fieldsToReveal: Object.freeze(Object.keys(keyring))
  })
  if (assessment.authorized !== true) throw new Error('Disclosure reliance denied')
  const status = snapshotJsonObject(
    assessment.status,
    'status assessment'
  ) as unknown as BRC52StatusResult
  if (status.outpoint !== source.revocationOutpoint)
    throw new Error('Status assessment outpoint mismatch')
  if (
    status.privacy.mode === 'issuer-per-presentation' ||
    status.reason === 'issuer-tracking-prohibited'
  ) {
    throw new Error('Issuer-tracking status retrieval cannot authorize disclosure')
  }
  const identity = await options.wallet.getPublicKey({ identityKey: true })
  if (identityKey(identity.publicKey, 'wallet identity') !== verifier) {
    throw new Error('Receiving wallet identity mismatch')
  }
  const relianceTime = options.now()
  assertDuration(relianceTime, 'reliance time', Number.MAX_SAFE_INTEGER)
  if (relianceTime < now || relianceTime - session.authenticatedAt > maxRequestAgeMs) {
    throw new Error('Authenticated request expired during reliance assessment')
  }
  const disclosedFields: Record<string, string> = {}
  await Object.entries(keyring).reduce(async (previous, [fieldName, ciphertext]) => {
    // Start each wallet operation only after the prior field completed successfully.
    await previous
    const result = await options.wallet.decrypt({
      protocolID: [2, 'certificate field encryption'],
      keyID: `${source.serialNumber} ${fieldName}`,
      counterparty: source.subject,
      ciphertext: decodeBRC52Base64(ciphertext, 80, 80)
    })
    const key = snapshotBytes(result.plaintext, 'field revelation key', 32, [32])
    let plaintext: number[]
    try {
      plaintext = new SymmetricKey(key).decrypt(
        decodeBRC52Base64(source.fields[fieldName], BRC52_LIMITS.fieldValueBytes, 48)
      ) as number[]
    } finally {
      key.fill(0)
    }
    try {
      defineOwn(
        disclosedFields,
        fieldName,
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(plaintext))
      )
    } finally {
      plaintext.fill(0)
    }
  }, Promise.resolve())
  return {
    verifiedDocument: envelope.credential,
    disclosedFields,
    source: {
      certificateBinary: envelope.certificateBinary,
      subject: source.subject,
      certifier: source.certifier,
      revocationOutpoint: source.revocationOutpoint
    },
    recipient: verifier,
    authenticatedRequest: session,
    status
  }
}

function validateReceipt(
  value: BRC52AuthenticatedRequest,
  payload: Uint8Array,
  subject: string,
  verifier: string,
  operation: string,
  purpose: string
): Omit<BRC52AuthenticatedRequest, 'payload'> {
  const receipt = getOwnDataProperties(
    value,
    'authenticated receipt',
    new Set([
      'peer',
      'receivingVerifier',
      'payload',
      'operation',
      'purpose',
      'nonce',
      'authenticatedAt',
      'sessionId'
    ])
  )
  const authenticatedPayload = snapshotBytes(
    receipt.payload as Uint8Array,
    'authenticated payload',
    MAX_PAYLOAD_BYTES
  )
  if (
    authenticatedPayload.length !== payload.length ||
    authenticatedPayload.some((byte, index) => byte !== payload[index])
  ) {
    throw new Error('Authenticated payload does not match exact incoming envelope bytes')
  }
  if (
    receipt.peer !== subject ||
    receipt.receivingVerifier !== verifier ||
    receipt.operation !== operation ||
    receipt.purpose !== purpose
  ) {
    throw new Error('Authenticated subject, recipient, operation or purpose mismatch')
  }
  assertDuration(receipt.authenticatedAt, 'authenticatedAt', Number.MAX_SAFE_INTEGER)
  return {
    peer: subject,
    receivingVerifier: verifier,
    operation,
    purpose,
    nonce: contextString(receipt.nonce, 'authenticated nonce'),
    authenticatedAt: receipt.authenticatedAt,
    sessionId: contextString(receipt.sessionId, 'sessionId')
  }
}

function identityKey(value: unknown, label: string): string {
  assertBoundedString(value, label, 66)
  if (!/^(02|03)[0-9a-f]{64}$/.test(value) || PublicKey.fromString(value).toString() !== value)
    throw new TypeError(`${label} must be a valid compressed lowercase identity key`)
  return value
}

function contextString(value: unknown, label: string, maximum = MAX_CONTEXT_BYTES): string {
  assertBoundedString(value, label, maximum)
  return value
}

function selectedFields(value: readonly string[], fields: Record<string, string>): string[] {
  if (!Array.isArray(value) || value.length > Object.keys(fields).length)
    throw new TypeError('Invalid field selection')
  const selection = snapshotJsonValue(value, 'field selection') as string[]
  if (
    new Set(selection).size !== selection.length ||
    selection.some(name => typeof name !== 'string' || !hasOwn(fields, name))
  )
    throw new TypeError('Field selection contains duplicate or unknown names')
  return selection
}

function walletCertificate(source: SourceCertificate) {
  return {
    type: source.type,
    serialNumber: source.serialNumber,
    subject: source.subject,
    certifier: source.certifier,
    revocationOutpoint: source.revocationOutpoint,
    fields: { ...source.fields },
    signature: source.signature
  }
}

function inputBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') {
    assertBoundedString(value, 'envelope', MAX_PAYLOAD_BYTES)
    const bytes = new TextEncoder().encode(value)
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== value)
      throw new TypeError('Envelope is not well-formed UTF-8')
    return bytes
  }
  return new Uint8Array(snapshotBytes(value, 'envelope', MAX_PAYLOAD_BYTES))
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => hasOwn(b, key) && sameJson(a[key], b[key]))
  )
}
