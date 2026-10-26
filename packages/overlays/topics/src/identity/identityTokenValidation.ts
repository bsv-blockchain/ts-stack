import { toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { ProtoWallet, PushDrop, VerifiableCertificate, type TransactionOutput } from '@bsv/sdk'
const MAX_CERTIFICATE_BYTES = 256 * 1024
const MAX_CERTIFICATE_FIELDS = 100
const IDENTITY_PROTOCOL: [1, 'identity'] = [1, 'identity']
const IDENTITY_KEY_ID = '1'
const allowedCertificateKeys = new Set([
  'type',
  'serialNumber',
  'subject',
  'certifier',
  'revocationOutpoint',
  'fields',
  'keyring',
  'signature'
])

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !('value' in descriptor)) {
    throw new Error(`Identity certificate ${key} must be an own data property`)
  }
  return descriptor.value
}

function boundedBytes(value: unknown, field: string, minimum: number, maximum: number): number[] {
  const normalized = value instanceof Uint8Array ? Array.from(value) : value
  if (!Array.isArray(normalized) || normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${field} must contain ${minimum}-${maximum} bytes`)
  }
  for (let index = 0; index < normalized.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(normalized, index) ||
      !Number.isInteger(normalized[index]) ||
      normalized[index] < 0 ||
      normalized[index] > 255
    ) {
      throw new Error(`${field} must be a dense byte array`)
    }
  }
  return Array.from(normalized)
}

function pushOpcode(value: number[]): number {
  if (value.length <= 75) return value.length
  if (value.length <= 0xff) return 0x4c
  if (value.length <= 0xffff) return 0x4d
  return 0x4e
}

function parseCertificate(encoded: number[]): Record<string, unknown> {
  const certificate = plainRecord(JSON.parse(toUTF8Strict(encoded)), 'Identity certificate')
  const keys = Reflect.ownKeys(certificate)
  if (
    keys.length !== allowedCertificateKeys.size ||
    keys.some(key => typeof key !== 'string' || !allowedCertificateKeys.has(key))
  ) {
    throw new Error('Identity certificate has missing or unexpected fields')
  }
  for (const key of allowedCertificateKeys) ownData(certificate, key)
  const fields = plainRecord(ownData(certificate, 'fields'), 'Identity certificate fields')
  const keyring = plainRecord(ownData(certificate, 'keyring'), 'Identity certificate keyring')
  const fieldNames = Object.keys(fields)
  const keyringNames = Object.keys(keyring)
  if (
    fieldNames.length < 1 ||
    fieldNames.length > MAX_CERTIFICATE_FIELDS ||
    keyringNames.length < 1 ||
    keyringNames.length > MAX_CERTIFICATE_FIELDS
  ) {
    throw new Error('Identity certificate fields or keyring have invalid cardinality')
  }
  for (const fieldName of keyringNames) {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
      throw new Error('Identity keyring refers to an absent certificate field')
    }
  }
  return certificate
}

export async function validateIdentityOutput(
  output: TransactionOutput,
  anyoneWallet: ProtoWallet
): Promise<{ certificate: VerifiableCertificate; decryptedFields: Record<string, string> }> {
  const result = PushDrop.decode(output.lockingScript)
  if (result.fields.length !== 2) throw new Error('Identity token must contain exactly two fields')
  const certificateBytes = boundedBytes(
    result.fields[0],
    'Identity certificate',
    1,
    MAX_CERTIFICATE_BYTES
  )
  const fieldSignature = boundedBytes(result.fields[1], 'Identity field signature', 8, 80)
  const chunks = output.lockingScript.chunks
  if (
    chunks.length !== 5 ||
    chunks[0].op !== 33 ||
    chunks[0].data?.length !== 33 ||
    chunks[1].op !== 0xac ||
    chunks[2].op !== pushOpcode(certificateBytes) ||
    chunks[3].op !== pushOpcode(fieldSignature) ||
    chunks[4].op !== 0x6d
  ) {
    throw new Error('Identity token must use the canonical signed PushDrop script')
  }

  const parsedCert = parseCertificate(certificateBytes)
  const subject = ownData(parsedCert, 'subject')
  if (typeof subject !== 'string') throw new Error('Identity certificate subject must be a string')
  const { publicKey: expectedLockingKey } = await anyoneWallet.getPublicKey({
    protocolID: IDENTITY_PROTOCOL,
    keyID: IDENTITY_KEY_ID,
    counterparty: subject
  })
  if (result.lockingPublicKey.toString() !== expectedLockingKey) {
    throw new Error('Identity token locking key does not belong to the certificate subject')
  }
  const signatureResult = await anyoneWallet.verifySignature({
    data: certificateBytes,
    signature: fieldSignature,
    counterparty: subject,
    protocolID: IDENTITY_PROTOCOL,
    keyID: IDENTITY_KEY_ID
  })
  if (signatureResult.valid !== true) throw new Error('Invalid identity field signature')

  const certificate = new VerifiableCertificate(
    ownData(parsedCert, 'type') as string,
    ownData(parsedCert, 'serialNumber') as string,
    subject,
    ownData(parsedCert, 'certifier') as string,
    ownData(parsedCert, 'revocationOutpoint') as string,
    ownData(parsedCert, 'fields') as Record<string, string>,
    ownData(parsedCert, 'keyring') as Record<string, string>,
    ownData(parsedCert, 'signature') as string
  )
  if ((await certificate.verify()) !== true) throw new Error('Invalid certificate signature')
  const decryptedFields = await certificate.decryptFields(anyoneWallet)
  if (Object.keys(decryptedFields).length === 0) {
    throw new Error('No publicly revealed attributes present')
  }
  return { certificate, decryptedFields }
}
