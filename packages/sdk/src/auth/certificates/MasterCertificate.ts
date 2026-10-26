import {
  Base64String,
  CertificateFieldNameUnder50Bytes,
  HexString,
  OutpointString,
  PubKeyHex,
  WalletCounterparty
} from '../../wallet/Wallet.interfaces.js'
import Certificate from './Certificate.js'
import { toArray as UtilsToArray, toBase64, toUTF8Strict } from '../../primitives/utils.js'
import SymmetricKey from '../../primitives/SymmetricKey.js'
import Random from '../../primitives/Random.js'
import type ProtoWallet from '../../wallet/ProtoWallet.js'
import PublicKey from '../../primitives/PublicKey.js'
import { isUnsafeRecordKey } from '../../primitives/SafeRecord.js'
import { base64ToBytes } from '../../wallet/WalletByteEncoding.js'

const MAX_MASTER_CERTIFICATE_FIELDS = 100
const MAX_MASTER_KEYRING_VALUE_BYTES = 2048
const MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES = 1024 * 1024
const MAX_DECRYPTED_CERTIFICATE_FIELD_BYTES = 64 * 1024

function assertCertificateFieldName(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Certificate field names must be strings')
  const byteLength = UtilsToArray(value, 'utf8').length
  if (byteLength < 1 || byteLength > 50 || isUnsafeRecordKey(value)) {
    throw new Error('Certificate field name must be a safe UTF-8 string of 1–50 bytes')
  }
}

function snapshotStringRecord(
  value: unknown,
  field: string,
  maximumEntries = MAX_MASTER_CERTIFICATE_FIELDS
): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain object`)
  }
  const names = Reflect.ownKeys(value)
  if (names.length > maximumEntries) {
    throw new Error(`${field} cannot contain more than ${maximumEntries} entries`)
  }
  const snapshot = Object.create(null) as Record<string, string>
  for (const name of names) {
    assertCertificateFieldName(name)
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      throw new Error(`${field}.${name} must be an own string data property`)
    }
    snapshot[name] = descriptor.value
  }
  return snapshot
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

function canonical32ByteBase64(value: string, field: string): void {
  const decoded = canonicalBase64(value, field, 32)
  if (decoded.length !== 32) throw new Error(`${field} must encode exactly 32 bytes`)
}

function denseBytes(value: unknown, field: string, maximumBytes: number): number[] {
  const bytes = value instanceof Uint8Array ? Array.from(value) : value
  if (!Array.isArray(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new Error(`${field} must be a non-empty byte array of at most ${maximumBytes} bytes`)
  }
  const snapshot = Array.from<number>({ length: bytes.length })
  for (let index = 0; index < bytes.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, index)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new Error(`${field} must be a dense byte array`)
    }
    snapshot[index] = descriptor.value
  }
  return snapshot
}

function assertCompressedPublicKey(value: string, field: string): void {
  try {
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(value)) throw new Error('invalid encoding')
    PublicKey.fromString(value)
  } catch {
    throw new Error(`${field} must be a valid compressed public key`)
  }
}

function assertRevocationOutpoint(value: string): void {
  const parts = value.split('.')
  const [txid, outputIndex = '0'] = parts
  if (
    parts.length > 2 ||
    !/^[0-9a-fA-F]{64}$/.test(txid) ||
    !/^(?:0|[1-9]\d*)$/.test(outputIndex) ||
    Number(outputIndex) > 0xffffffff
  ) {
    throw new Error('Certificate revocation outpoint is invalid')
  }
}

function snapshotFieldsToReveal(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MASTER_CERTIFICATE_FIELDS) {
    throw new TypeError(
      `fieldsToReveal must be an array of at most ${MAX_MASTER_CERTIFICATE_FIELDS} strings`
    )
  }
  const snapshot: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('fieldsToReveal must be a dense array of strings')
    }
    assertCertificateFieldName(descriptor.value)
    if (seen.has(descriptor.value)) {
      throw new Error(`fieldsToReveal contains duplicate field: ${descriptor.value}`)
    }
    seen.add(descriptor.value)
    snapshot.push(descriptor.value)
  }
  return snapshot
}

interface CreateCertificateFieldsResult {
  certificateFields: Record<CertificateFieldNameUnder50Bytes, Base64String>
  masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>
}

/**
 * MasterCertificate extends the base Certificate class to manage a master keyring, enabling the creation of verifiable certificates.
 *
 * It allows for the selective disclosure of certificate fields by creating a `VerifiableCertificate` for a specific verifier.
 * The `MasterCertificate` can securely decrypt each master key and re-encrypt it for a verifier, creating a customized
 * keyring containing only the keys necessary for the verifier to access designated fields.
 *
 * Inputs are copied and bounded before wallet calls. New field-revelation keys
 * are encoded as exactly 32 bytes; decryption also accepts the historical
 * minimal big-endian 1–31-byte form and restores omitted leading zero bytes.
 */
export class MasterCertificate extends Certificate {
  declare type: Base64String
  declare serialNumber: Base64String
  declare subject: PubKeyHex
  declare certifier: PubKeyHex
  declare revocationOutpoint: OutpointString
  declare fields: Record<CertificateFieldNameUnder50Bytes, Base64String>
  declare signature?: HexString

  masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>

  constructor(
    ...[
      type,
      serialNumber,
      subject,
      certifier,
      revocationOutpoint,
      fields,
      masterKeyring,
      signature
    ]: [
      type: Base64String,
      serialNumber: Base64String,
      subject: PubKeyHex,
      certifier: PubKeyHex,
      revocationOutpoint: OutpointString,
      fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
      masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
      signature?: HexString
    ]
  ) {
    const fieldsSnapshot = snapshotStringRecord(fields, 'Certificate fields') as Record<
      CertificateFieldNameUnder50Bytes,
      Base64String
    >
    const masterKeyringSnapshot = snapshotStringRecord(
      masterKeyring,
      'Master certificate keyring'
    ) as Record<CertificateFieldNameUnder50Bytes, Base64String>

    // Ensure every field in `fields` is a string and has a corresponding key in `masterKeyring`
    for (const fieldName of Object.keys(fieldsSnapshot)) {
      if (
        masterKeyringSnapshot[fieldName] === undefined ||
        masterKeyringSnapshot[fieldName] === ''
      ) {
        throw new Error(
          `Master keyring must contain a value for every field. Missing or empty key for field: "${fieldName}".`
        )
      }
      canonicalBase64(
        fieldsSnapshot[fieldName],
        `Certificate field ${fieldName}`,
        MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES
      )
      canonicalBase64(
        masterKeyringSnapshot[fieldName],
        `Master certificate keyring field ${fieldName}`,
        MAX_MASTER_KEYRING_VALUE_BYTES
      )
    }
    for (const fieldName of Object.keys(masterKeyringSnapshot)) {
      canonicalBase64(
        masterKeyringSnapshot[fieldName],
        `Master certificate keyring field ${fieldName}`,
        MAX_MASTER_KEYRING_VALUE_BYTES
      )
    }

    super(type, serialNumber, subject, certifier, revocationOutpoint, fieldsSnapshot, signature)
    this.masterKeyring = masterKeyringSnapshot
  }

  /**
   * Encrypts certificate fields for a subject and generates a master keyring.
   * This method returns a master keyring tied to a specific certifier or subject who will validate
   * and sign off on the fields, along with the encrypted certificate fields.
   *
   * @param {ProtoWallet} creatorWallet - The wallet of the creator responsible for encrypting the fields.
   * @param {WalletCounterparty} certifierOrSubject - The certifier or subject who will validate the certificate fields.
   * @param {Record<CertificateFieldNameUnder50Bytes, string>} fields - A record of certificate field names (under 50 bytes) mapped to their values.
   * @param {BooleanDefaultFalse} [privileged] - Whether this is a privileged request.
   * @param {DescriptionString5to50Bytes} [privilegedReason] - Reason provided for privileged access, required if this is a privileged operation.   *
   * @returns {Promise<CreateCertificateFieldsResult>} A promise resolving to an object containing:
   *   - `certificateFields` {Record<CertificateFieldNameUnder50Bytes, Base64String>}:
   *     The encrypted certificate fields.
   *   - `masterKeyring` {Record<CertificateFieldNameUnder50Bytes, Base64String>}:
   *     The master keyring containing encrypted revelation keys for each field.
   */
  static async createCertificateFields(
    creatorWallet: ProtoWallet,
    certifierOrSubject: WalletCounterparty,
    fields: Record<CertificateFieldNameUnder50Bytes, string>,
    privileged?: boolean,
    privilegedReason?: string
  ): Promise<CreateCertificateFieldsResult> {
    const fieldsSnapshot = snapshotStringRecord(fields, 'Certificate plaintext fields')
    const certificateFields = Object.create(null) as Record<
      CertificateFieldNameUnder50Bytes,
      Base64String
    >
    const masterKeyring = Object.create(null) as Record<
      CertificateFieldNameUnder50Bytes,
      Base64String
    >
    for (const [fieldName, fieldValue] of Object.entries(fieldsSnapshot)) {
      const plaintext = UtilsToArray(fieldValue, 'utf8')
      if (plaintext.length > MAX_DECRYPTED_CERTIFICATE_FIELD_BYTES) {
        throw new Error(
          `Certificate plaintext field ${fieldName} exceeds the maximum of ${MAX_DECRYPTED_CERTIFICATE_FIELD_BYTES} bytes`
        )
      }
      const fieldSymmetricKey = SymmetricKey.fromRandom()
      const encryptedFieldValue = denseBytes(
        fieldSymmetricKey.encrypt(plaintext),
        `Encrypted certificate field ${fieldName}`,
        MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES
      )
      certificateFields[fieldName] = toBase64(encryptedFieldValue)

      const { ciphertext: encryptedFieldRevelationKey } = await creatorWallet.encrypt({
        plaintext: fieldSymmetricKey.toArray('be', 32),
        ...Certificate.getCertificateFieldEncryptionDetails(fieldName), // Only fieldName used on MasterCertificate
        counterparty: certifierOrSubject,
        privileged,
        privilegedReason
      })
      masterKeyring[fieldName] = toBase64(
        denseBytes(
          encryptedFieldRevelationKey,
          `Encrypted master keyring field ${fieldName}`,
          MAX_MASTER_KEYRING_VALUE_BYTES
        )
      )
    }

    return {
      certificateFields,
      masterKeyring
    }
  }

  /**
   * Creates a keyring for a verifier, enabling them to decrypt specific certificate fields.
   * This method decrypts the master field keys for the specified fields and re-encrypts them
   * for the verifier's identity key. The result is a keyring containing the keys necessary
   * for the verifier to access the designated fields.
   *
   * @param {ProtoWallet} subjectWallet - The wallet instance of the subject, used to decrypt and re-encrypt field keys.
   * @param {WalletCounterparty} verifier - The verifier who will receive access to the selectively revealed fields. Can be an identity key as hex, 'anyone', or 'self'.
   * @param {string[]} fieldsToReveal - An array of field names to be revealed to the verifier. Must be a subset of the certificate's fields.
   * @param {string} [originator] - Optional originator identifier, used if additional context is needed for decryption and encryption operations.
   * @returns {Promise<Record<CertificateFieldNameUnder50Bytes, string>>} - A keyring mapping field names to encrypted field revelation keys, allowing the verifier to decrypt specified fields.
   * @param {BooleanDefaultFalse} [privileged] - Whether this is a privileged request.
   * @param {DescriptionString5to50Bytes} [privilegedReason] - Reason provided for privileged access, required if this is a privileged operation.   *
   * @throws {Error} Throws an error if:
   *   - fieldsToReveal is not an array of strings.
   *   - A field in `fieldsToReveal` does not exist in the certificate.
   *   - The decrypted master field key fails to decrypt the corresponding field (indicating an invalid key).
   */
  static async createKeyringForVerifier(
    ...[
      subjectWallet,
      certifier,
      verifier,
      fields,
      fieldsToReveal,
      masterKeyring,
      serialNumber,
      privileged,
      privilegedReason
    ]: [
      subjectWallet: ProtoWallet,
      certifier: WalletCounterparty,
      verifier: WalletCounterparty,
      fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
      fieldsToReveal: string[],
      masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
      serialNumber: Base64String,
      privileged?: boolean,
      privilegedReason?: string
    ]
  ): Promise<Record<CertificateFieldNameUnder50Bytes, string>> {
    const revealedFields = snapshotFieldsToReveal(fieldsToReveal)
    const fieldsSnapshot = snapshotStringRecord(fields, 'Certificate fields')
    const masterKeyringSnapshot = snapshotStringRecord(masterKeyring, 'Master certificate keyring')
    for (const fieldName of Object.keys(fieldsSnapshot)) {
      canonicalBase64(
        fieldsSnapshot[fieldName],
        `Certificate field ${fieldName}`,
        MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES
      )
    }
    for (const fieldName of Object.keys(masterKeyringSnapshot)) {
      canonicalBase64(
        masterKeyringSnapshot[fieldName],
        `Master certificate keyring field ${fieldName}`,
        MAX_MASTER_KEYRING_VALUE_BYTES
      )
    }
    canonical32ByteBase64(serialNumber, 'Certificate serial number')
    const fieldRevelationKeyring = Object.create(null) as Record<
      CertificateFieldNameUnder50Bytes,
      string
    >
    for (const fieldName of revealedFields) {
      // Make sure that fields to reveal is a subset of the certificate fields
      if (
        fieldsSnapshot[fieldName] === undefined ||
        fieldsSnapshot[fieldName] === null ||
        fieldsSnapshot[fieldName] === ''
      ) {
        throw new Error(
          `Fields to reveal must be a subset of the certificate fields. Missing the "${fieldName}" field.`
        )
      }

      // Decrypt the master field key and verify that derived key actually decrypts requested field
      const masterFieldKey = (
        await this.decryptField(
          subjectWallet,
          masterKeyringSnapshot,
          fieldName,
          fieldsSnapshot[fieldName],
          certifier,
          privileged,
          privilegedReason
        )
      ).fieldRevelationKey

      // Encrypt derived fieldRevelationKey for verifier
      const { ciphertext: encryptedFieldRevelationKey } = await subjectWallet.encrypt({
        plaintext: masterFieldKey,
        ...Certificate.getCertificateFieldEncryptionDetails(fieldName, serialNumber),
        counterparty: verifier,
        privileged,
        privilegedReason
      })

      // Add encryptedFieldRevelationKey to fieldRevelationKeyring
      fieldRevelationKeyring[fieldName] = toBase64(
        denseBytes(
          encryptedFieldRevelationKey,
          `Verifier keyring field ${fieldName}`,
          MAX_MASTER_KEYRING_VALUE_BYTES
        )
      )
    }

    // Return the field revelation keyring which can be used to create a verifiable certificate for a verifier.
    return fieldRevelationKeyring
  }

  /**
   * Issues a new MasterCertificate for a specified subject.
   *
   * This method generates a certificate containing encrypted fields and a keyring
   * for the subject to decrypt all fields. Each field is encrypted with a randomly
   * generated symmetric key, which is then encrypted for the subject. The certificate
   * can also includes a revocation outpoint to manage potential revocation.
   *
   * @param {ProtoWallet} certifierWallet - The wallet of the certifier, used to sign the certificate and encrypt field keys.
   * @param {WalletCounterparty} subject - The subject for whom the certificate is issued.
   * @param {Record<CertificateFieldNameUnder50Bytes, string>} fields - Unencrypted certificate fields to include, with their names and values.
   * @param {Base64String} certificateType - The 32-byte Base64 certificate type being issued.
   * @param {function(string, Record<CertificateFieldNameUnder50Bytes, string>?): Promise<string>} getRevocationOutpoint -
   *   Optional function to obtain a revocation outpoint for the certificate. Defaults to a placeholder.
   * @param {function(string): Promise<void>} updateProgress - Optional callback for reporting progress updates during the operation. Defaults to a no-op.
   * @returns {Promise<MasterCertificate>} - A signed MasterCertificate instance containing the encrypted fields and subject specific keyring.
   *
   * @throws {Error} Throws an error if any operation (e.g., encryption, signing) fails during certificate issuance.
   */
  static async issueCertificateForSubject(
    certifierWallet: ProtoWallet,
    subject: WalletCounterparty,
    fields: Record<CertificateFieldNameUnder50Bytes, string>,
    certificateType: Base64String,
    getRevocationOutpoint = async (_serial: string): Promise<string> => '00'.repeat(32),
    serialNumber?: string
  ): Promise<MasterCertificate> {
    // 1. Generate a random serialNumber if not provided
    const finalSerialNumber = serialNumber ?? toBase64(Random(32))
    canonical32ByteBase64(certificateType, 'Certificate type')
    canonical32ByteBase64(finalSerialNumber, 'Certificate serial number')

    const { publicKey: certifierIdentityKey } = await certifierWallet.getPublicKey({
      identityKey: true
    })
    assertCompressedPublicKey(certifierIdentityKey, 'Certificate certifier')

    let subjectIdentityKey: string
    if (subject === 'self') {
      subjectIdentityKey = certifierIdentityKey
    } else {
      subjectIdentityKey = subject
      assertCompressedPublicKey(subjectIdentityKey, 'Certificate subject')
    }

    // 2. Create encrypted certificate fields and associated master keyring
    const { certificateFields, masterKeyring } = await this.createCertificateFields(
      certifierWallet,
      subject,
      fields
    )

    // 3. Obtain a revocation outpoint
    const revocationOutpoint = await getRevocationOutpoint(finalSerialNumber)
    assertRevocationOutpoint(revocationOutpoint)

    // 4. Create new MasterCertificate instance
    const certificate = new MasterCertificate(
      certificateType,
      finalSerialNumber,
      subjectIdentityKey,
      certifierIdentityKey,
      revocationOutpoint,
      certificateFields,
      masterKeyring
    )

    // 5. Sign and return the new MasterCertificate certifying the subject.
    await certificate.sign(certifierWallet)
    if (subject === 'self' && certificate.subject !== certificate.certifier) {
      throw new Error('Self-issued certificate signer identity changed during issuance')
    }
    return certificate
  }

  /**
   * Decrypts all fields in the MasterCertificate using the subject's or certifier's wallet.
   *
   * This method allows the subject or certifier to decrypt the `masterKeyring` and retrieve
   * the encryption keys for each field, which are then used to decrypt the corresponding field values.
   * The counterparty used for decryption depends on how the certificate fields were created:
   * - If the certificate is self-signed, the counterparty should be set to 'self'.
   * - Otherwise, the counterparty should always be the other party involved in the certificate issuance process (the subject or certifier).
   *
   * @param {ProtoWallet} subjectOrCertifierWallet - The wallet of the subject or certifier, used to decrypt the master keyring and field values.
   * @param {Record<CertificateFieldNameUnder50Bytes, Base64String>} masterKeyring - A record containing encrypted keys for each field.
   * @param {Record<CertificateFieldNameUnder50Bytes, Base64String>} fields - A record of encrypted field names and their values.
   * @param {WalletCounterparty} counterparty - The counterparty responsible for creating or signing the certificate. For self-signed certificates, use 'self'.
   * @param {BooleanDefaultFalse} [privileged] - Whether this is a privileged request.
   * @param {DescriptionString5to50Bytes} [privilegedReason] - Reason provided for privileged access, required if this is a privileged operation.
   * @returns {Promise<Record<CertificateFieldNameUnder50Bytes, string>>} A promise resolving to a record of field names and their decrypted values in plaintext.
   *
   * @throws {Error} Throws an error if the `masterKeyring` is invalid or if decryption fails for any field.
   */
  static async decryptFields(
    subjectOrCertifierWallet: ProtoWallet,
    masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
    fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
    counterparty: WalletCounterparty,
    privileged?: boolean,
    privilegedReason?: string
  ): Promise<Record<CertificateFieldNameUnder50Bytes, string>> {
    const masterKeyringSnapshot = snapshotStringRecord(masterKeyring, 'Master certificate keyring')
    const fieldsSnapshot = snapshotStringRecord(fields, 'Certificate fields')
    if (Object.keys(masterKeyringSnapshot).length === 0) {
      throw new Error('A MasterCertificate must have a valid masterKeyring!')
    }
    try {
      for (const fieldName of Object.keys(masterKeyringSnapshot)) {
        canonicalBase64(
          masterKeyringSnapshot[fieldName],
          `Master certificate keyring field ${fieldName}`,
          MAX_MASTER_KEYRING_VALUE_BYTES
        )
      }
      for (const fieldName of Object.keys(fieldsSnapshot)) {
        canonicalBase64(
          fieldsSnapshot[fieldName],
          `Certificate field ${fieldName}`,
          MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES
        )
      }
      const decryptedFields = Object.create(null) as Record<
        CertificateFieldNameUnder50Bytes,
        string
      >
      // Note: we want to iterate through all fields, not just masterKeyring keys/value pairs.
      for (const fieldName of Object.keys(fieldsSnapshot)) {
        decryptedFields[fieldName] = (
          await this.decryptField(
            subjectOrCertifierWallet,
            masterKeyringSnapshot,
            fieldName,
            fieldsSnapshot[fieldName],
            counterparty,
            privileged,
            privilegedReason
          )
        ).decryptedFieldValue
      }
      return decryptedFields
    } catch {
      throw new Error('Failed to decrypt all master certificate fields.')
    }
  }

  static async decryptField(
    subjectOrCertifierWallet: ProtoWallet,
    masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
    fieldName: Base64String,
    fieldValue: Base64String,
    counterparty: WalletCounterparty,
    privileged?: boolean,
    privilegedReason?: string
  ): Promise<{ fieldRevelationKey: number[]; decryptedFieldValue: string }> {
    try {
      assertCertificateFieldName(fieldName)
      const masterKeyringSnapshot = snapshotStringRecord(
        masterKeyring,
        'Master certificate keyring'
      )
      if (Object.keys(masterKeyringSnapshot).length === 0) {
        throw new Error('A MasterCertificate must have a valid masterKeyring!')
      }
      const encryptedKey = canonicalBase64(
        masterKeyringSnapshot[fieldName],
        `Master certificate keyring field ${fieldName}`,
        MAX_MASTER_KEYRING_VALUE_BYTES
      )
      const encryptedField = canonicalBase64(
        fieldValue,
        `Certificate field ${fieldName}`,
        MAX_ENCRYPTED_CERTIFICATE_FIELD_BYTES
      )
      const { plaintext: fieldRevelationKey } = await subjectOrCertifierWallet.decrypt({
        ciphertext: encryptedKey,
        ...Certificate.getCertificateFieldEncryptionDetails(fieldName), // Only fieldName used on MasterCertificate
        counterparty,
        privileged,
        privilegedReason
      })

      const legacyRevelationKey = denseBytes(
        fieldRevelationKey,
        'Certificate field revelation key',
        32
      )
      // Older certificate keyrings may contain the minimal big-endian encoding
      // emitted by BigNumber.toArray(). Preserve compatibility by restoring the
      // omitted leading zero bytes before using the key as AES-256 material.
      const revelationKey = [
        ...Array.from<number>({ length: 32 - legacyRevelationKey.length }).fill(0),
        ...legacyRevelationKey
      ]
      const decryptedFieldValue = denseBytes(
        new SymmetricKey(revelationKey).decrypt(encryptedField),
        'Decrypted certificate field',
        MAX_DECRYPTED_CERTIFICATE_FIELD_BYTES
      )
      return {
        fieldRevelationKey: revelationKey,
        decryptedFieldValue: toUTF8Strict(decryptedFieldValue)
      }
    } catch {
      throw new Error('Failed to decrypt certificate field!')
    }
  }
}
