import { Curve, PrivateKey, PublicKey, Signature } from '@bsv/sdk/primitives'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { Certificate } from '@bsv/sdk/auth'
import { publicKeyToDidKey } from '../utils/multibase.js'
import {
  assertBoundedString,
  getOwnDataProperties,
  hasOwn,
  parseStrictJson,
  snapshotBytes,
  snapshotJsonValue
} from '../validation.js'
import type { JsonValue } from '../types.js'
import type {
  BRC52CertificateCore,
  BRC52Context,
  BRC52CredentialGraph,
  BRC52Disclosure,
  BRC52Envelope,
  BRC52VerificationResult,
  ParsedBRC52Certificate
} from './types.js'

export const BRC52_VOCABULARY =
  'https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0203.md#'
export const BRC52_ENVELOPE_PROFILE = `${BRC52_VOCABULARY}BRC52EnvelopeV1`
export const BRC52_DISABLED_OUTPOINT = `${'0'.repeat(64)}.0`
export const BRC52_LIMITS = Object.freeze({
  certificateBytes: 65_536,
  jsonBytes: 262_144,
  fields: 256,
  fieldValueBytes: 16_384,
  fieldNameBytes: 50
})
const CORE_KEYS = new Set([
  'type',
  'serialNumber',
  'subject',
  'certifier',
  'revocationOutpoint',
  'fields',
  'signature'
])
const ENVELOPE_KEYS = new Set(['profile', 'certificateBinary', 'credential', 'disclosure'])
const DISCLOSURE_KEYS = new Set(['subject', 'verifier', 'keyring'])

export function decodeBRC52Base64(
  value: unknown,
  maximumBytes: number,
  minimumBytes = 0
): number[] {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError('Invalid canonical BRC-52 Base64')
  }
  const bytes = toArray(value, 'base64')
  if (bytes.length < minimumBytes || bytes.length > maximumBytes || toBase64(bytes) !== value)
    throw new TypeError('Invalid canonical BRC-52 Base64 length or spelling')
  return bytes
}

function exactKeys(record: Record<string, unknown>, required: readonly string[]): void {
  for (const name of required)
    if (!hasOwn(record, name)) throw new TypeError(`Missing BRC-52 member ${name}`)
}

function utf8(bytes: number[]): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes))
}

class SourceReader {
  offset = 0
  constructor(readonly bytes: number[]) {}
  take(length: number): number[] {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset)
      throw new TypeError('Truncated BRC-52 source')
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }
  compactSize(maximum: number): number {
    const prefix = this.take(1)[0]
    if (prefix < 253) {
      if (prefix > maximum) throw new TypeError('BRC-52 CompactSize exceeds limit')
      return prefix
    }
    let width = 8
    let minimum = 4_294_967_296n
    if (prefix === 253) {
      width = 2
      minimum = 253n
    } else if (prefix === 254) {
      width = 4
      minimum = 65_536n
    }
    const raw = this.take(width)
    let value = 0n
    for (let index = width - 1; index >= 0; index--) value = value * 256n + BigInt(raw[index])
    if (value < minimum || value > BigInt(maximum))
      throw new TypeError('Noncanonical or oversized BRC-52 CompactSize')
    return Number(value)
  }
}

function strictSignature(bytes: number[]): Signature {
  if (bytes.length < 8 || bytes.length > 72)
    throw new TypeError('Invalid BRC-52 DER signature size')
  const signature = Signature.fromDER(bytes)
  const encoded = signature.toDER() as number[]
  const order = new Curve().n
  if (
    toHex(encoded) !== toHex(bytes) ||
    signature.r.cmpn(0) <= 0 ||
    signature.s.cmpn(0) <= 0 ||
    signature.r.gte(order) ||
    signature.s.gte(order)
  )
    throw new TypeError('Invalid canonical BRC-52 DER signature')
  return signature
}

function identityKey(bytes: number[]): string {
  // The profile encoder validates exact compressed point bytes without normalization.
  publicKeyToDidKey(bytes)
  return toHex(bytes)
}

/** Parse and authenticate the original prefix; field enumeration is never sorted. */
export function verifyBRC52CertificateBinary(
  binary: number[] | Uint8Array
): ParsedBRC52Certificate {
  const bytes = snapshotBytes(binary, 'BRC-52 certificate', BRC52_LIMITS.certificateBytes)
  const reader = new SourceReader(bytes)
  const type = toBase64(reader.take(32))
  const serialNumber = toBase64(reader.take(32))
  const subject = identityKey(reader.take(33))
  const certifier = identityKey(reader.take(33))
  const txid = toHex(reader.take(32))
  const outputIndex = reader.compactSize(0xff_ff_ff_ff)
  const count = reader.compactSize(BRC52_LIMITS.fields)
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (let index = 0; index < count; index++) {
    const nameLength = reader.compactSize(BRC52_LIMITS.fieldNameBytes)
    if (nameLength === 0) throw new TypeError('Empty BRC-52 field name')
    const name = utf8(reader.take(nameLength))
    if (hasOwn(fields, name)) throw new TypeError('Duplicate BRC-52 field name')
    const value = utf8(reader.take(reader.compactSize(BRC52_LIMITS.fieldValueBytes)))
    decodeBRC52Base64(value, BRC52_LIMITS.fieldValueBytes, 48)
    fields[name] = value
  }
  const unsignedPrefix = bytes.slice(0, reader.offset)
  const signatureBytes = reader.take(bytes.length - reader.offset)
  const signature = strictSignature(signatureBytes)
  const signingKey = PublicKey.fromString(certifier).deriveChild(
    new PrivateKey(1),
    `2-certificate signature-${type} ${serialNumber}`
  )
  if (!signingKey.verify(unsignedPrefix, signature))
    throw new Error('BRC-52 original signature verification failed')
  return {
    type,
    serialNumber,
    subject,
    certifier,
    revocationOutpoint: `${txid}.${outputIndex}`,
    fields,
    signature: toHex(signatureBytes),
    unsignedPrefix,
    certificateBinary: bytes
  }
}

function context(): BRC52Context {
  return {
    '@protected': true,
    brc: { '@id': BRC52_VOCABULARY, '@prefix': true },
    certificateType: 'brc:certificateType',
    serialNumber: 'brc:serialNumber',
    revocationOutpoint: 'brc:revocationOutpoint',
    encryptedFields: { '@id': 'brc:encryptedFields', '@type': '@json' }
  }
}

function graph(source: ParsedBRC52Certificate): BRC52CredentialGraph {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of Object.keys(source.fields)) fields[name] = source.fields[name]
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', context()],
    type: ['VerifiableCredential', 'brc:BRC52EncryptedCertificate'],
    issuer: publicKeyToDidKey(source.certifier),
    credentialSubject: { id: publicKeyToDidKey(source.subject), encryptedFields: fields },
    certificateType: source.type,
    serialNumber: source.serialNumber,
    revocationOutpoint: source.revocationOutpoint,
    ...(source.revocationOutpoint === BRC52_DISABLED_OUTPOINT
      ? {}
      : {
          credentialStatus: {
            type: 'brc:BRC52OutpointStatus' as const,
            revocationOutpoint: source.revocationOutpoint
          }
        })
  }
}

/** Exporter: no signing, no decrypting, no network operation. */
export function exportBRC52Envelope(binary: number[] | Uint8Array): BRC52Envelope {
  const source = verifyBRC52CertificateBinary(binary)
  return {
    profile: BRC52_ENVELOPE_PROFILE,
    certificateBinary: toBase64(source.certificateBinary),
    credential: graph(source)
  }
}

/** JSON-only compatibility path: reject if local serialization cannot authenticate the original signature. */
export function exportBRC52StructuredCertificate(value: BRC52CertificateCore): BRC52Envelope {
  const core = getOwnDataProperties(value, 'BRC-52 structured core', CORE_KEYS)
  exactKeys(core, [...CORE_KEYS])
  const fields = snapshotJsonValue(core.fields, 'BRC-52 structured fields')
  if (
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Object.values(fields).some(field => typeof field !== 'string')
  )
    throw new TypeError('Invalid BRC-52 structured fields')
  for (const name of [
    'type',
    'serialNumber',
    'subject',
    'certifier',
    'revocationOutpoint',
    'signature'
  ])
    if (typeof core[name] !== 'string') throw new TypeError(`Invalid BRC-52 ${name}`)
  const certificate = new Certificate(
    core.type as string,
    core.serialNumber as string,
    core.subject as string,
    core.certifier as string,
    core.revocationOutpoint as string,
    fields as Record<string, string>,
    core.signature as string
  )
  return exportBRC52Envelope(certificate.toBinary())
}

export function validateBRC52Disclosure(
  value: unknown,
  source: ParsedBRC52Certificate
): BRC52Disclosure {
  const disclosure = getOwnDataProperties(value, 'BRC-52 disclosure', DISCLOSURE_KEYS)
  exactKeys(disclosure, [...DISCLOSURE_KEYS])
  if (disclosure.subject !== source.subject || typeof disclosure.verifier !== 'string')
    throw new TypeError('BRC-52 disclosure subject or verifier mismatch')
  publicKeyToDidKey(disclosure.verifier)
  if (!/^(02|03)[0-9a-f]{64}$/.test(disclosure.verifier))
    throw new TypeError('Noncanonical BRC-52 disclosure verifier')
  const keyring = getOwnDataProperties(
    disclosure.keyring,
    'BRC-52 verifier keyring',
    new Set(Object.keys(source.fields))
  )
  const copy: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(keyring)) {
    decodeBRC52Base64(value, 80, 80)
    copy[name] = value as string
  }
  return { subject: source.subject, verifier: disclosure.verifier, keyring: copy }
}

function equalGraph(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equalGraph(value, b[index]))
    )
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(name => hasOwn(b, name) && equalGraph(a[name] as JsonValue, b[name] as JsonValue))
  )
}

/** Strict transport parser. Duplicate JSON members and invalid UTF-8 fail before use. */
export function parseBRC52Envelope(input: string | Uint8Array): {
  envelope: BRC52Envelope
  source: ParsedBRC52Certificate
} {
  const text =
    typeof input === 'string'
      ? input
      : utf8(snapshotBytes(input, 'BRC-52 JSON', BRC52_LIMITS.jsonBytes))
  assertBoundedString(text, 'BRC-52 envelope', BRC52_LIMITS.jsonBytes)
  const parsed = parseStrictJson(text, 'BRC-52 envelope')
  const object = getOwnDataProperties(parsed, 'BRC-52 envelope', ENVELOPE_KEYS)
  exactKeys(object, ['profile', 'certificateBinary', 'credential'])
  if (object.profile !== BRC52_ENVELOPE_PROFILE)
    throw new TypeError('Unsupported BRC-52 envelope profile')
  const source = verifyBRC52CertificateBinary(
    decodeBRC52Base64(object.certificateBinary, BRC52_LIMITS.certificateBytes)
  )
  const computed = graph(source)
  if (
    !equalGraph(
      snapshotJsonValue(object.credential, 'BRC-52 credential graph'),
      snapshotJsonValue(computed, 'BRC-52 computed graph')
    )
  )
    throw new TypeError('BRC-52 credential projection mismatch')
  const disclosure = hasOwn(object, 'disclosure')
    ? validateBRC52Disclosure(object.disclosure, source)
    : undefined
  return {
    envelope: {
      profile: BRC52_ENVELOPE_PROFILE,
      certificateBinary: toBase64(source.certificateBinary),
      credential: computed,
      ...(disclosure === undefined ? {} : { disclosure })
    },
    source
  }
}

/** Cryptographic verification only: trust, status, consent and live control are separate. */
export function verifyBRC52Envelope(
  inputMediaType: string,
  inputData: string | Uint8Array
): BRC52VerificationResult {
  try {
    if (inputMediaType !== 'application/json')
      throw new TypeError('Unsupported BRC-52 input media type')
    const { envelope } = parseBRC52Envelope(inputData)
    return {
      verified: true,
      verifiedDocument: envelope.credential,
      mediaType: 'application/vc',
      errors: []
    }
  } catch (error) {
    return {
      verified: false,
      verifiedDocument: null,
      mediaType: null,
      errors: [error instanceof Error ? error.message : 'BRC-52 verification failed']
    }
  }
}
