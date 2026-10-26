import type {
  PubKeyHex,
  Base64String,
  CertificateFieldNameUnder50Bytes,
  HexString,
  OutpointString,
  WalletCertificate,
  OriginatorDomainNameStringUnder250Bytes
} from '../../wallet/Wallet.interfaces.js'
import SymmetricKey from '../../primitives/SymmetricKey.js'
import { toArray, toUTF8Strict } from '../../primitives/utils.js'
import type ProtoWallet from '../../wallet/ProtoWallet.js'
import Certificate from './Certificate.js'
import { isUnsafeRecordKey } from '../../primitives/SafeRecord.js'
import { base64ToBytes } from '../../wallet/WalletByteEncoding.js'

const MAX_REVEALED_FIELDS = 100
const MAX_KEYRING_VALUE_BYTES = 2048
const MAX_ENCRYPTED_FIELD_BYTES = 1024 * 1024
const MAX_DECRYPTED_FIELD_BYTES = 64 * 1024

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

function ownString(record: Record<string, unknown>, key: string, field: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new Error(`${field} must be an own string data property`)
  }
  return descriptor.value
}

function canonicalBase64(value: string, field: string, maximumBytes: number): number[] {
  let decoded: number[]
  try {
    decoded = base64ToBytes(value)
  } catch {
    throw new Error(`${field} must use canonical base64 encoding`)
  }
  if (decoded.length < 1 || decoded.length > maximumBytes) {
    throw new Error(`${field} is empty, oversized, or non-canonical`)
  }
  return decoded
}

function denseBytes(value: unknown, field: string, exactLength?: number): number[] {
  const normalized = value instanceof Uint8Array ? Array.from(value) : value
  if (
    !Array.isArray(normalized) ||
    (exactLength !== undefined && normalized.length !== exactLength)
  ) {
    throw new Error(
      `${field} must be a${exactLength === undefined ? '' : ` ${exactLength}-`}byte array`
    )
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

/**
 * VerifiableCertificate extends the Certificate class, adding functionality to manage a verifier-specific keyring.
 * This keyring allows selective decryption of certificate fields for authorized verifiers.
 */
export class VerifiableCertificate extends Certificate {
  declare type: Base64String
  declare serialNumber: Base64String
  declare subject: PubKeyHex
  declare certifier: PubKeyHex
  declare revocationOutpoint: OutpointString
  declare fields: Record<CertificateFieldNameUnder50Bytes, string>
  declare signature?: HexString

  keyring: Record<CertificateFieldNameUnder50Bytes, string>
  decryptedFields?: Record<CertificateFieldNameUnder50Bytes, Base64String>

  constructor(
    ...[
      type,
      serialNumber,
      subject,
      certifier,
      revocationOutpoint,
      fields,
      keyring,
      signature,
      decryptedFields
    ]: [
      type: Base64String,
      serialNumber: Base64String,
      subject: PubKeyHex,
      certifier: PubKeyHex,
      revocationOutpoint: OutpointString,
      fields: Record<CertificateFieldNameUnder50Bytes, string>,
      keyring: Record<CertificateFieldNameUnder50Bytes, string>,
      signature?: HexString,
      decryptedFields?: Record<CertificateFieldNameUnder50Bytes, Base64String>
    ]
  ) {
    super(type, serialNumber, subject, certifier, revocationOutpoint, fields, signature)
    this.keyring = keyring
    this.decryptedFields = decryptedFields
  }

  /**
   *
   * @param {WalletCertificate} certificate – The source certificate that was issued and signed by the certifier.
   * @param {Record<CertificateFieldNameUnder50Bytes, string>} keyring – A allows the verifier to decrypt selected certificate fields.
   * @returns {VerifiableCertificate} – A fully-formed instance containing the
   *   original certificate data plus the supplied keyring.
   */
  static fromCertificate(
    certificate: WalletCertificate,
    keyring: Record<CertificateFieldNameUnder50Bytes, string>
  ): VerifiableCertificate {
    return new VerifiableCertificate(
      certificate.type,
      certificate.serialNumber,
      certificate.subject,
      certificate.certifier,
      certificate.revocationOutpoint,
      certificate.fields,
      keyring,
      certificate.signature
    )
  }

  /**
   * Decrypts selectively revealed certificate fields using the provided keyring and verifier wallet
   * @param {ProtoWallet} verifierWallet - The wallet instance of the certificate's verifier, used to decrypt field keys.
   * @returns {Promise<Record<CertificateFieldNameUnder50Bytes, string>>} - A promise that resolves to an object where each key is a field name and each value is the decrypted field value as a string.
   * @param {BooleanDefaultFalse} [privileged] - Whether this is a privileged request.
   * @param {DescriptionString5to50Bytes} [privilegedReason] - Reason provided for privileged access, required if this is a privileged operation.
   * @throws {Error} Throws an error if any of the decryption operations fail, with a message indicating the failure context.
   */
  async decryptFields(
    verifierWallet: ProtoWallet,
    privileged?: boolean,
    privilegedReason?: string,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<Record<CertificateFieldNameUnder50Bytes, string>> {
    const keyring = plainRecord(this.keyring, 'Certificate keyring')
    const fields = plainRecord(this.fields, 'Certificate fields')
    const fieldNames = Reflect.ownKeys(keyring)
    if (fieldNames.length === 0) {
      throw new Error('A keyring is required to decrypt certificate fields for the verifier.')
    }
    if (fieldNames.length > MAX_REVEALED_FIELDS) {
      throw new Error(`Certificate keyring cannot contain more than ${MAX_REVEALED_FIELDS} fields`)
    }

    try {
      const decryptedFields = Object.create(null) as Record<
        CertificateFieldNameUnder50Bytes,
        string
      >
      for (const fieldName of fieldNames) {
        if (
          typeof fieldName !== 'string' ||
          isUnsafeRecordKey(fieldName) ||
          toArray(fieldName, 'utf8').length < 1 ||
          toArray(fieldName, 'utf8').length > 50
        ) {
          throw new Error('Certificate keyring contains an unsafe field name')
        }
        const encryptedKey = canonicalBase64(
          ownString(keyring, fieldName, `Certificate keyring field ${fieldName}`),
          `Certificate keyring field ${fieldName}`,
          MAX_KEYRING_VALUE_BYTES
        )
        const encryptedField = canonicalBase64(
          ownString(fields, fieldName, `Certificate field ${fieldName}`),
          `Certificate field ${fieldName}`,
          MAX_ENCRYPTED_FIELD_BYTES
        )
        const { plaintext: fieldRevelationKey } = await verifierWallet.decrypt(
          {
            ciphertext: encryptedKey,
            ...Certificate.getCertificateFieldEncryptionDetails(fieldName, this.serialNumber),
            counterparty: this.subject,
            privileged,
            privilegedReason
          },
          originator
        )

        const revelationKey = denseBytes(fieldRevelationKey, 'Certificate field revelation key', 32)
        const fieldValue = denseBytes(
          new SymmetricKey(revelationKey).decrypt(encryptedField),
          'Decrypted certificate field'
        )
        if (fieldValue.length > MAX_DECRYPTED_FIELD_BYTES) {
          throw new Error('Decrypted certificate field is oversized')
        }
        decryptedFields[fieldName] = toUTF8Strict(fieldValue)
      }
      return decryptedFields
    } catch (error) {
      throw new Error(
        `Failed to decrypt selectively revealed certificate fields using keyring: ${String(error instanceof Error ? error.message : error)}`
      )
    }
  }
}
