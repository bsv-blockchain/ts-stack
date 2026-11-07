import { Certificate } from '@bsv/sdk/auth'
import { Random } from '@bsv/sdk/primitives'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'

/**
 * BRC-235 profile certificates: the self-signed BRC-52 certificates the
 * public profile lookup and reverse lookup capabilities exchange.
 *
 * The host is a directory, not an authority on what a profile says. Every
 * certificate read from a host passes {@link verifyProfileCertificate} before
 * any field of it is shown or used. `Certificate.verify()` alone is not that
 * decision: it proves the certificate was signed by the key it names as
 * certifier, which only says something about the subject once
 * `subject === certifier` has been checked separately.
 */

/** base64(SHA-256("public profile lookup")): the profile certificate type. */
export const PROFILE_CERTIFICATE_TYPE = 'SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE='
/** Profiles are replaced or tombstoned, never revoked on chain. */
export const PROFILE_REVOCATION_OUTPOINT = `${'0'.repeat(64)}.0`
export const PROFILE_MAX_FIELDS = 32
/** Exclusive, as in go-sdk's `CertificateFieldNameUnder50Bytes`. */
export const PROFILE_MAX_FIELD_NAME_BYTES = 50
export const PROFILE_MAX_FIELD_VALUE_BYTES = 1024
export const PROFILE_MAX_CERTIFICATE_BYTES = 16384
/** The most results a lookup returns, and the most a client processes. */
export const PROFILE_LOOKUP_MAX_RESULTS = 10
export const PROFILE_LOOKUP_MIN_QUERY_LENGTH = 2
export const PROFILE_LOOKUP_MAX_QUERY_LENGTH = 32

const HANDLE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/
const QUERY = /^[a-z0-9._-]+$/
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const COMPRESSED_PUBLIC_KEY = /^0[23][0-9a-f]{64}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/
const UNSAFE_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const CERTIFICATE_KEYS = [
  'type',
  'serialNumber',
  'subject',
  'certifier',
  'revocationOutpoint',
  'fields',
  'signature'
] as const

/** The seven-member BRC-52 JSON form of a profile certificate. */
export interface ProfileCertificateJson {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

/** A profile certificate that passed every BRC-235 client verification rule. */
export interface VerifiedProfile {
  /** The holder's identity key: the BRC-29 payment recipient. */
  identityKey: string
  paymail: string
  handle: string
  domain: string
  displayName?: string
  issuedAt: string
  certificate: ProfileCertificateJson
}

/** What a verified certificate must also match. */
export interface ProfileExpectation {
  /** The domain that was resolved; `fields.paymail` must be at it. */
  domain: string
  /** A complete paymail the user typed; `fields.paymail` must equal it. */
  paymail?: string
  /** The key a reverse lookup asked for; `subject` must equal it. */
  identityKey?: string
}

/** The two wallet methods `Certificate.sign` uses. */
export interface ProfileSigner {
  getPublicKey: (args: { identityKey: true }) => Promise<{ publicKey: string }>
  createSignature: (args: {
    data: number[]
    protocolID: [0 | 1 | 2, string]
    keyID: string
    counterparty?: string
  }) => Promise<{ signature: number[] }>
}

function utf8Length(value: string): number {
  return toArray(value, 'utf8').length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Whether `handle` is a BRC-235 handle: 1-32 of a-z 0-9 . _ -, alphanumeric at each end. */
export function isValidProfileHandle(handle: string): boolean {
  return typeof handle === 'string' && HANDLE.test(handle)
}

/** Whether `value` is 66 lowercase hex characters of a compressed public key. */
export function isProfileIdentityKey(value: string): boolean {
  return typeof value === 'string' && COMPRESSED_PUBLIC_KEY.test(value)
}

/**
 * The handle text a host searches for, or undefined when the query can match
 * nothing at `domain`. Lowercases and trims; strips an `@domain` suffix when
 * the suffix is `domain` or a prefix of it (a domain still being typed).
 */
export function normalizeProfileLookupQuery(query: string, domain: string): string | undefined {
  if (typeof query !== 'string' || typeof domain !== 'string') return undefined
  let normalized = query.trim().toLowerCase()
  const at = normalized.indexOf('@')
  if (at !== -1) {
    const suffix = normalized.slice(at + 1)
    if (suffix.includes('@') || !domain.toLowerCase().startsWith(suffix)) return undefined
    normalized = normalized.slice(0, at)
  }
  if (
    normalized.length < PROFILE_LOOKUP_MIN_QUERY_LENGTH ||
    normalized.length > PROFILE_LOOKUP_MAX_QUERY_LENGTH ||
    !QUERY.test(normalized) ||
    normalized === '..'
  ) {
    return undefined
  }
  return normalized
}

function withinLimits(fields: Record<string, string>): boolean {
  const names = Object.keys(fields)
  if (names.length > PROFILE_MAX_FIELDS) return false
  return names.every(
    name =>
      utf8Length(name) < PROFILE_MAX_FIELD_NAME_BYTES &&
      typeof fields[name] === 'string' &&
      utf8Length(fields[name]) <= PROFILE_MAX_FIELD_VALUE_BYTES
  )
}

/**
 * The certificate as its seven JSON members, or undefined when it is not a
 * BRC-235 profile certificate for `domain`. Checks every rule except the
 * signature, so a host can screen what it serves cheaply. Tombstones fail.
 */
export function checkProfileCertificate(
  value: unknown,
  domain: string
): ProfileCertificateJson | undefined {
  if (!isPlainRecord(value)) return undefined
  for (const key of CERTIFICATE_KEYS) {
    if (key === 'fields' ? !isPlainRecord(value[key]) : typeof value[key] !== 'string') {
      return undefined
    }
  }
  const rawFields = value.fields as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const [name, fieldValue] of Object.entries(rawFields)) {
    if (typeof fieldValue !== 'string' || UNSAFE_FIELD_NAMES.has(name)) return undefined
    fields[name] = fieldValue
  }
  const json: ProfileCertificateJson = {
    type: value.type as string,
    serialNumber: value.serialNumber as string,
    subject: value.subject as string,
    certifier: value.certifier as string,
    revocationOutpoint: value.revocationOutpoint as string,
    fields,
    signature: value.signature as string
  }
  if (
    json.type !== PROFILE_CERTIFICATE_TYPE ||
    !BASE64_32_BYTES.test(json.serialNumber) ||
    !isProfileIdentityKey(json.subject.toLowerCase()) ||
    json.subject.toLowerCase() !== json.certifier.toLowerCase() ||
    json.revocationOutpoint !== PROFILE_REVOCATION_OUTPOINT ||
    !withinLimits(fields) ||
    utf8Length(JSON.stringify(json)) > PROFILE_MAX_CERTIFICATE_BYTES ||
    fields.released === 'true' ||
    typeof fields.issuedAt !== 'string' ||
    !RFC3339.test(fields.issuedAt) ||
    !Number.isFinite(Date.parse(fields.issuedAt))
  ) {
    return undefined
  }
  const paymail = fields.paymail
  const expectedDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : ''
  if (typeof paymail !== 'string' || expectedDomain === '') return undefined
  const at = paymail.lastIndexOf('@')
  if (
    at <= 0 ||
    paymail.slice(at + 1) !== expectedDomain ||
    !isValidProfileHandle(paymail.slice(0, at))
  ) {
    return undefined
  }
  return json
}

/**
 * Applies every BRC-235 client verification rule, signature included. Answers
 * the profile, or undefined for a certificate to discard; never throws, since
 * callers are filtering a list and one bad row is a row to leave out.
 */
export async function verifyProfileCertificate(
  value: unknown,
  expect: ProfileExpectation
): Promise<VerifiedProfile | undefined> {
  try {
    const json = checkProfileCertificate(value, expect.domain)
    if (json == null) return undefined
    if (expect.paymail != null && json.fields.paymail !== expect.paymail.trim().toLowerCase()) {
      return undefined
    }
    if (
      expect.identityKey != null &&
      json.subject.toLowerCase() !== expect.identityKey.toLowerCase()
    ) {
      return undefined
    }
    const certificate = new Certificate(
      json.type,
      json.serialNumber,
      json.subject,
      json.certifier,
      json.revocationOutpoint,
      json.fields,
      json.signature
    )
    if (!(await certificate.verify())) return undefined
    const paymail = json.fields.paymail
    const at = paymail.lastIndexOf('@')
    const displayName = json.fields.displayName
    return {
      identityKey: json.subject.toLowerCase(),
      paymail,
      handle: paymail.slice(0, at),
      domain: paymail.slice(at + 1),
      ...(typeof displayName === 'string' && displayName !== '' ? { displayName } : {}),
      issuedAt: json.fields.issuedAt,
      certificate: json
    }
  } catch {
    return undefined
  }
}

/**
 * Signs a BRC-235 profile certificate with the holder's identity key.
 * `fields` adds free-form fields; `paymail`, `issuedAt` and `released` are set
 * from the named arguments and cannot be overridden through it.
 */
export async function createProfileCertificate(args: {
  signer: ProfileSigner
  paymail: string
  issuedAt?: Date
  displayName?: string
  released?: boolean
  fields?: Record<string, string>
}): Promise<ProfileCertificateJson> {
  const paymail = args.paymail.trim().toLowerCase()
  const at = paymail.lastIndexOf('@')
  if (
    at <= 0 ||
    !isValidProfileHandle(paymail.slice(0, at)) ||
    !DOMAIN.test(paymail.slice(at + 1))
  ) {
    throw new Error(`Invalid profile paymail: "${args.paymail}"`)
  }
  const issuedAt = args.issuedAt ?? new Date()
  if (!Number.isFinite(issuedAt.getTime())) throw new Error('issuedAt is not a valid date')
  const fields: Record<string, string> = {}
  for (const [name, value] of Object.entries(args.fields ?? {})) {
    if (UNSAFE_FIELD_NAMES.has(name)) throw new Error(`Invalid profile field name: "${name}"`)
    if (name !== 'released') fields[name] = value
  }
  fields.paymail = paymail
  fields.issuedAt = issuedAt.toISOString()
  const displayName = args.displayName?.trim() ?? ''
  if (displayName !== '') fields.displayName = displayName
  if (args.released === true) fields.released = 'true'
  if (!withinLimits(fields)) throw new Error('Profile certificate fields exceed BRC-235 limits')

  const { publicKey } = await args.signer.getPublicKey({ identityKey: true })
  const certificate = new Certificate(
    PROFILE_CERTIFICATE_TYPE,
    toBase64(Random(32)),
    publicKey,
    publicKey,
    PROFILE_REVOCATION_OUTPOINT,
    fields
  )
  await certificate.sign(args.signer as unknown as Parameters<Certificate['sign']>[0])
  const json: ProfileCertificateJson = {
    type: certificate.type,
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    certifier: certificate.certifier,
    revocationOutpoint: certificate.revocationOutpoint,
    fields: { ...certificate.fields },
    signature: certificate.signature ?? ''
  }
  if (json.signature === '' || json.subject !== json.certifier) {
    throw new Error('Profile certificate signing did not produce a self-signed certificate')
  }
  if (utf8Length(JSON.stringify(json)) > PROFILE_MAX_CERTIFICATE_BYTES) {
    throw new Error(`Profile certificate exceeds ${PROFILE_MAX_CERTIFICATE_BYTES} bytes`)
  }
  return json
}
