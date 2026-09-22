import {
  createPublicHTTPSFetch,
  MasterCertificate,
  ProtoWallet,
  PublicKey,
  Signature
} from '@bsv/sdk'
import { Writer, toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { CertificateData } from './types'

export const MAX_CERTIFICATE_FIELDS = 100
export const MAX_CERTIFICATE_RESPONSE_BYTES = 512 * 1024
export const CERTIFICATE_REQUEST_TIMEOUT_MS = 15_000

const MAX_REMOTE_ERROR_BYTES = 512
const MAX_FIELD_VALUE_BYTES = 64 * 1024
const MAX_LEGACY_CERTIFICATE_TYPE_BYTES = 128
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type PlainRecord = Record<string, unknown>

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) as number
    return code < 0x20 || code === 0x7f
  })
}

export function snapshotPlainDataRecord(value: unknown): PlainRecord | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const snapshot = Object.create(null) as PlainRecord
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return undefined
      const descriptor = descriptors[key]
      if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
        return undefined
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        writable: false,
        configurable: false
      })
    }
    return snapshot
  } catch {
    return undefined
  }
}

export function isPlainDataRecord(value: unknown): value is PlainRecord {
  return snapshotPlainDataRecord(value) != null
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Length(value) > maximum) {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

function canonicalBase64(value: unknown, name: string, exactBytes?: number): string {
  const encoded = requiredString(value, name, MAX_FIELD_VALUE_BYTES)
  let bytes: number[]
  try {
    bytes = toArray(encoded, 'base64')
  } catch {
    throw new TypeError(`Invalid ${name}`)
  }
  if ((exactBytes != null && bytes.length !== exactBytes) || toBase64(bytes) !== encoded) {
    throw new TypeError(`Invalid ${name}`)
  }
  return encoded
}

export function canonicalCertificateType(value: unknown): string {
  return canonicalBase64(value, 'certificate type', 32)
}

/**
 * Validate a persisted pre-canonical certificate type. Legacy releases
 * accepted canonical base64 identifiers shorter than the BRC-100 32-byte
 * type, so local verification and migration paths retain bounded support for
 * those records. Remote service metadata must still use
 * canonicalCertificateType().
 */
export function legacyCompatibleCertificateType(value: unknown): string {
  const encoded = canonicalBase64(value, 'certificate type')
  const bytes = toArray(encoded, 'base64')
  if (bytes.length < 1 || bytes.length > MAX_LEGACY_CERTIFICATE_TYPE_BYTES) {
    throw new TypeError('Invalid certificate type')
  }
  return encoded
}

export function canonicalIdentityKey(value: unknown, name: string): string {
  const encoded = requiredString(value, name, 66)
  try {
    const canonical = PublicKey.fromString(encoded).toString()
    if (canonical !== encoded || !/^(?:02|03)[0-9a-f]{64}$/.test(encoded)) {
      throw new TypeError(`Invalid ${name}`)
    }
    return canonical
  } catch {
    throw new TypeError(`Invalid ${name}`)
  }
}

function canonicalOutpoint(value: unknown): string {
  const encoded = requiredString(value, 'certificate revocation outpoint', 76)
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/.exec(encoded)
  if (match == null || Number(match[2]) > 0xffffffff) {
    throw new TypeError('Invalid certificate revocation outpoint')
  }
  return encoded
}

function canonicalSignature(value: unknown): string {
  const encoded = requiredString(value, 'certificate signature', 144)
  if (!/^[0-9a-f]+$/.test(encoded) || encoded.length % 2 !== 0) {
    throw new TypeError('Invalid certificate signature')
  }
  try {
    if (Signature.fromDER(toArray(encoded, 'hex')).toString('hex') !== encoded) {
      throw new TypeError('Invalid certificate signature')
    }
  } catch {
    throw new TypeError('Invalid certificate signature')
  }
  return encoded
}

function stringMap(value: unknown, name: string, base64Values: boolean): Record<string, string> {
  const record = snapshotPlainDataRecord(value)
  if (record == null) throw new TypeError(`Invalid ${name}`)
  const entries = Object.entries(record)
  if (entries.length > MAX_CERTIFICATE_FIELDS) throw new TypeError(`Invalid ${name}`)
  const output = Object.create(null) as Record<string, string>
  for (const [key, raw] of entries) {
    const keyBytes = utf8Length(key)
    if (keyBytes < 1 || keyBytes > 50 || UNSAFE_KEYS.has(key)) {
      throw new TypeError(`Invalid ${name}`)
    }
    output[key] = base64Values
      ? canonicalBase64(raw, `${name}.${key}`)
      : requiredString(raw, `${name}.${key}`, MAX_FIELD_VALUE_BYTES)
  }
  return output
}

export function validateCredentialFields(value: unknown): Record<string, string> {
  return stringMap(value, 'credential fields', false)
}

export function validateSchemaId(value: unknown): string | undefined {
  if (value == null) return undefined
  const schemaId = requiredString(value, 'credential schema identifier', 128)
  if (schemaId !== schemaId.trim() || hasControlCharacters(schemaId)) {
    throw new TypeError('Invalid credential schema identifier')
  }
  return schemaId
}

export interface ExpectedCertificate {
  certifier?: string
  subject?: string
  type?: string
}

export interface CertificateValidationOptions {
  /** Exact, locally configured pre-canonical identifiers accepted for persisted records. */
  legacyCertificateTypes?: string[]
}

function snapshotLegacyCertificateTypes(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError('Invalid legacy certificate types')
  }
  const types: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new TypeError('Invalid legacy certificate types')
    }
    types.push(legacyCompatibleCertificateType(descriptor.value))
  }
  return [...new Set(types)]
}

/** UTF-16 code-unit order, the same order as a comparator-less `Array#sort`. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function historicalCertificatePreimage(certificate: CertificateData): number[] {
  const writer = new Writer()
  writer.write(toArray(certificate.type, 'base64'))
  writer.write(toArray(certificate.serialNumber, 'base64'))
  writer.write(toArray(certificate.subject, 'hex'))
  writer.write(toArray(certificate.certifier, 'hex'))
  const [txid, outputIndex] = certificate.revocationOutpoint.split('.')
  writer.write(toArray(txid, 'hex'))
  writer.writeVarIntNum(Number(outputIndex))
  const fieldNames = Object.keys(certificate.fields).sort((left, right) =>
    left.localeCompare(right)
  )
  writer.writeVarIntNum(fieldNames.length)
  for (const fieldName of fieldNames) {
    const nameBytes = toArray(fieldName, 'utf8')
    const valueBytes = toArray(certificate.fields[fieldName], 'utf8')
    writer.writeVarIntNum(nameBytes.length)
    writer.write(nameBytes)
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }
  return writer.toArray()
}

async function verifyHistoricalCertificate(certificate: CertificateData): Promise<boolean> {
  try {
    const verifier = new ProtoWallet('anyone')
    const { valid } = await verifier.verifySignature({
      signature: toArray(certificate.signature, 'hex'),
      data: historicalCertificatePreimage(certificate),
      protocolID: [2, 'certificate signature'],
      keyID: `${certificate.type} ${certificate.serialNumber}`,
      counterparty: certificate.certifier
    })
    return valid === true
  } catch {
    return false
  }
}

/**
 * Own and authenticate an untrusted direct-acquisition certificate before it
 * can change wallet state or be represented as a verified credential.
 */
export async function validateCertificateData(
  value: unknown,
  expected: ExpectedCertificate = {},
  options: CertificateValidationOptions = {}
): Promise<CertificateData> {
  const record = snapshotPlainDataRecord(value)
  const expectedRecord = snapshotPlainDataRecord(expected)
  const optionRecord = snapshotPlainDataRecord(options)
  if (record == null) throw new TypeError('Invalid certificate response')
  if (expectedRecord == null || optionRecord == null) {
    throw new TypeError('Invalid certificate validation options')
  }
  const legacyCertificateTypes = snapshotLegacyCertificateTypes(optionRecord.legacyCertificateTypes)
  const fields = stringMap(record.fields, 'certificate fields', true)
  const keyringForSubject = stringMap(record.keyringForSubject, 'certificate subject keyring', true)
  const fieldNames = Object.keys(fields).sort(compareCodeUnits)
  const keyNames = Object.keys(keyringForSubject).sort(compareCodeUnits)
  if (
    fieldNames.length !== keyNames.length ||
    fieldNames.some((field, index) => field !== keyNames[index])
  ) {
    throw new TypeError('Invalid certificate subject keyring')
  }

  let type: string
  let usesHistoricalEncoding = false
  try {
    type = canonicalCertificateType(record.type)
  } catch {
    type = legacyCompatibleCertificateType(record.type)
    if (!legacyCertificateTypes.includes(type)) throw new TypeError('Invalid certificate type')
    usesHistoricalEncoding = true
  }

  const certificate: CertificateData = {
    type,
    serialNumber: canonicalBase64(record.serialNumber, 'certificate serial number', 32),
    subject: canonicalIdentityKey(record.subject, 'certificate subject'),
    certifier: canonicalIdentityKey(record.certifier, 'certificate certifier'),
    revocationOutpoint: canonicalOutpoint(record.revocationOutpoint),
    fields,
    signature: canonicalSignature(record.signature),
    keyringForSubject
  }

  if (
    (expectedRecord.certifier != null && certificate.certifier !== expectedRecord.certifier) ||
    (expectedRecord.subject != null && certificate.subject !== expectedRecord.subject) ||
    (expectedRecord.type != null && certificate.type !== expectedRecord.type)
  ) {
    throw new Error('Certificate response does not match the requested issuer, subject, and type')
  }

  const valid = usesHistoricalEncoding
    ? await verifyHistoricalCertificate(certificate)
    : await new MasterCertificate(
        certificate.type,
        certificate.serialNumber,
        certificate.subject,
        certificate.certifier,
        certificate.revocationOutpoint,
        certificate.fields,
        certificate.keyringForSubject,
        certificate.signature
      ).verify()
  if (valid !== true) throw new Error('Certificate signature is invalid')
  return certificate
}

export function normalizeCertificateServiceUrl(value: unknown): URL {
  const encoded = requiredString(value, 'certificate service URL', 2048)
  if (encoded !== encoded.trim()) throw new TypeError('Invalid certificate service URL')
  let url: URL
  try {
    url = new URL(encoded)
  } catch {
    throw new TypeError('Invalid certificate service URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(
      'Certificate service URL must be credential-free HTTPS without query or fragment'
    )
  }
  return url
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers?.get('content-length')
  if (
    declared != null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_CERTIFICATE_RESPONSE_BYTES)
  ) {
    throw new Error('Certificate service response exceeds the configured limit')
  }
  const reader = response.body?.getReader()
  let text = ''
  if (reader == null) {
    text = await response.text()
    if (utf8Length(text) > MAX_CERTIFICATE_RESPONSE_BYTES) {
      throw new Error('Certificate service response exceeds the configured limit')
    }
  } else {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_CERTIFICATE_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('Certificate service response exceeds the configured limit')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Certificate service returned malformed JSON')
  }
}

export function remoteCertificateError(value: unknown, fallback: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Length(value) > MAX_REMOTE_ERROR_BYTES
  ) {
    return fallback
  }
  return hasControlCharacters(value) ? fallback : value
}

export interface CertificateServiceInfo {
  certifierPublicKey: string
  certificateType: string
}

export async function fetchCertificateServiceJson(
  serviceUrl: URL,
  action: 'info' | 'certify',
  init: RequestInit = {},
  trustedFetch?: typeof fetch
): Promise<unknown> {
  const url = new URL(serviceUrl.toString())
  url.searchParams.set('action', action)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CERTIFICATE_REQUEST_TIMEOUT_MS)
  try {
    const fetchClient = trustedFetch ?? createPublicHTTPSFetch(serviceUrl.origin)
    const response = await fetchClient(url.toString(), {
      ...init,
      redirect: 'error',
      signal: controller.signal
    })
    const body = await readBoundedJson(response)
    if (response.status !== 200) {
      const record = snapshotPlainDataRecord(body)
      const message =
        record == null
          ? `Certificate service returned HTTP ${response.status}`
          : remoteCertificateError(
              record.error,
              `Certificate service returned HTTP ${response.status}`
            )
      throw new Error(message)
    }
    return body
  } finally {
    clearTimeout(timeout)
  }
}

export function validateCertificateServiceInfo(value: unknown): CertificateServiceInfo {
  const record = snapshotPlainDataRecord(value)
  if (record == null) throw new TypeError('Certificate service returned invalid issuer information')
  return {
    certifierPublicKey: canonicalIdentityKey(
      record.certifierPublicKey,
      'certificate service certifier'
    ),
    certificateType: canonicalCertificateType(record.certificateType)
  }
}
