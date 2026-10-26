import { existingCertificateTypeBytes } from '../../wallet/CertificateType.js'
import {
  Base64String,
  PubKeyHex,
  HexString,
  OutpointString,
  CertificateFieldNameUnder50Bytes,
  WalletProtocol
} from '../../wallet/Wallet.interfaces.js'
import {
  ReaderUint8Array,
  Writer,
  toArray as UtilsToArray,
  toBase64,
  toHex,
  toUTF8Strict
} from '../../primitives/utils.js'
import type ProtoWallet from '../../wallet/ProtoWallet.js'
import Signature from '../../primitives/Signature.js'
import PublicKey from '../../primitives/PublicKey.js'
import BigNumber from '../../primitives/BigNumber.js'
import type PrivateKey from '../../primitives/PrivateKey.js'
import { isUnsafeRecordKey } from '../../primitives/SafeRecord.js'
import { base64ToBytes } from '../../wallet/WalletByteEncoding.js'

const MAX_CERTIFICATE_BINARY_BYTES = 16 * 1024 * 1024
const MAX_CERTIFICATE_FIELDS = 100_000
const MAX_CERTIFICATE_FIELD_VALUE_BYTES = 1024 * 1024
const MAX_CERTIFICATE_SIGNATURE_BYTES = 72

function assertCanonicalBase64Length(
  value: string,
  fieldName: string,
  expectedLength: number
): number[] {
  let decoded: number[]
  try {
    decoded = base64ToBytes(value)
  } catch {
    throw new Error(`Invalid certificate ${fieldName}: expected canonical base64`)
  }
  assertExactLength(decoded, fieldName, expectedLength)
  return decoded
}

function snapshotCertificateFields(
  value: unknown
): Record<CertificateFieldNameUnder50Bytes, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Certificate fields must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Certificate fields must be a plain object')
  }

  const fieldNames = Reflect.ownKeys(value)
  if (fieldNames.length > MAX_CERTIFICATE_FIELDS) {
    throw new Error(`Certificate field count exceeds the maximum of ${MAX_CERTIFICATE_FIELDS}`)
  }
  const snapshot = Object.create(null) as Record<CertificateFieldNameUnder50Bytes, string>
  for (const fieldName of fieldNames) {
    if (typeof fieldName !== 'string') {
      throw new Error('Certificate fields cannot contain symbol keys')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, fieldName)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      throw new Error(`Certificate field ${fieldName} must be an own string data property`)
    }
    const fieldNameBytes = UtilsToArray(fieldName, 'utf8')
    assertCertificateFieldName(fieldName, fieldNameBytes.length)
    const fieldValueBytes = UtilsToArray(descriptor.value, 'utf8')
    if (fieldValueBytes.length > MAX_CERTIFICATE_FIELD_VALUE_BYTES) {
      throw new Error(
        `Certificate field ${fieldName} exceeds the maximum of ${MAX_CERTIFICATE_FIELD_VALUE_BYTES} bytes`
      )
    }
    snapshot[fieldName] = descriptor.value
  }
  return snapshot
}

function snapshotCertificateBinary(value: number[] | Uint8Array): number[] {
  const bytes = value instanceof Uint8Array ? Array.from(value) : value
  if (!Array.isArray(bytes) || bytes.length > MAX_CERTIFICATE_BINARY_BYTES) {
    throw new Error(
      `Certificate binary must be a byte array of at most ${MAX_CERTIFICATE_BINARY_BYTES} bytes`
    )
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
      throw new Error('Certificate binary must be a dense byte array')
    }
    snapshot[index] = descriptor.value
  }
  return snapshot
}

function equalBytes(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function assertCertificateFieldName(fieldName: string, byteLength: number): void {
  if (byteLength < 1 || byteLength > 50) {
    throw new Error(
      `Invalid certificate field name length: expected 1–50 bytes, received ${byteLength}`
    )
  }
  if (isUnsafeRecordKey(fieldName)) {
    throw new Error(`Unsafe certificate field name: ${fieldName}`)
  }
}

function assertExactLength(value: number[], fieldName: string, expectedLength: number): void {
  if (value.length !== expectedLength) {
    throw new Error(
      `Invalid certificate ${fieldName} length: expected ${expectedLength} bytes, received ${value.length}`
    )
  }
}

function assertCompressedPublicKey(value: number[], fieldName: string): void {
  assertExactLength(value, fieldName, 33)
  try {
    PublicKey.fromDER(value)
  } catch {
    throw new Error(`Invalid certificate ${fieldName}: expected a compressed secp256k1 public key`)
  }
}

/**
 * Represents an Identity Certificate as per the Wallet interface specifications.
 *
 * This class provides methods to serialize and deserialize certificates, as well as signing and verifying the certificate's signature.
 */
export default class Certificate {
  /**
   * Type identifier as canonical base64. New signing requires 32 bytes; existing verification accepts 1–128 bytes.
   */
  type: Base64String

  /**
   * Unique serial number of the certificate, base64 encoded string, 32 bytes.
   */
  serialNumber: Base64String

  /**
   * The public key belonging to the certificate's subject, compressed public key hex string.
   */
  subject: PubKeyHex

  /**
   * Public key of the certifier who issued the certificate, compressed public key hex string.
   */
  certifier: PubKeyHex

  /**
   * The outpoint used to confirm that the certificate has not been revoked (TXID.OutputIndex), as a string.
   */
  revocationOutpoint: OutpointString

  /**
   * All the fields present in the certificate, with field names as keys and encrypted field values as Base64 strings.
   */
  fields: Record<CertificateFieldNameUnder50Bytes, Base64String>

  /**
   * Certificate signature by the certifier's private key, DER encoded hex string.
   */
  signature?: HexString

  /**
   * Constructs a new Certificate.
   *
   * @param {Base64String} type - Type identifier as canonical base64. New signing requires 32 bytes; existing verification accepts 1–128 bytes.
   * @param {Base64String} serialNumber - Unique serial number of the certificate, base64 encoded string, 32 bytes.
   * @param {PubKeyHex} subject - The public key belonging to the certificate's subject, compressed public key hex string.
   * @param {PubKeyHex} certifier - Public key of the certifier who issued the certificate, compressed public key hex string.
   * @param {OutpointString} revocationOutpoint - The outpoint used to confirm that the certificate has not been revoked (TXID.OutputIndex), as a string.
   * @param {Record<CertificateFieldNameUnder50Bytes, string>} fields - All the fields present in the certificate.
   * @param {HexString} signature - Certificate signature by the certifier's private key, DER encoded hex string.
   */
  constructor(
    type: Base64String,
    serialNumber: Base64String,
    subject: PubKeyHex,
    certifier: PubKeyHex,
    revocationOutpoint: OutpointString,
    fields: Record<CertificateFieldNameUnder50Bytes, string>,
    signature?: HexString
  ) {
    this.type = type
    this.serialNumber = serialNumber
    this.subject = subject
    this.certifier = certifier
    this.revocationOutpoint = revocationOutpoint
    this.fields = fields
    this.signature = signature
  }

  /**
   * Serializes the certificate into binary format, with or without a signature.
   *
   * Certificate field presentation order is part of the historical signed
   * representation: this implementation orders field names with the host's
   * default `localeCompare` behavior. Reordering fields differently from the
   * representation used when the certificate was serialized or signed is not
   * equivalent and will make signature verification fail. Issuers and
   * verifiers must therefore preserve the original representation and use
   * compatible ordering environments.
   *
   * @param {boolean} [includeSignature=true] - Whether to include the signature in the serialization.
   * @returns {number[]} - The serialized certificate in binary format.
   */
  toBinary(includeSignature: boolean = true): number[] {
    return this.#serialize(includeSignature, false)
  }

  // Transport adaptation never participates in the signed preimage.
  #serialize(includeSignature: boolean, existingType: boolean): number[] {
    const writer = new Writer()

    // Write type (Base64String, 32 bytes)
    const typeBytes = existingType
      ? existingCertificateTypeBytes(this.type)
      : assertCanonicalBase64Length(this.type, 'type', 32)
    writer.write(typeBytes)

    // Write serialNumber (Base64String, 32 bytes)
    const serialNumberBytes = assertCanonicalBase64Length(this.serialNumber, 'serial number', 32)
    writer.write(serialNumberBytes)

    // Write subject (33 bytes compressed PubKeyHex)
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(this.subject)) {
      throw new Error('Invalid certificate subject: expected compressed public key hex')
    }
    const subjectBytes = UtilsToArray(this.subject, 'hex')
    assertCompressedPublicKey(subjectBytes, 'subject')
    writer.write(subjectBytes)

    // Write certifier (33 bytes compressed PubKeyHex)
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(this.certifier)) {
      throw new Error('Invalid certificate certifier: expected compressed public key hex')
    }
    const certifierBytes = UtilsToArray(this.certifier, 'hex')
    assertCompressedPublicKey(certifierBytes, 'certifier')
    writer.write(certifierBytes)

    // Write revocationOutpoint (TXID + OutputIndex)
    if (typeof this.revocationOutpoint !== 'string') {
      throw new Error('Invalid certificate revocation outpoint')
    }
    const outpointParts = this.revocationOutpoint.split('.')
    // MasterCertificate historically uses a txid-only zero outpoint placeholder.
    const [txid, outputIndex = '0'] = outpointParts
    if (
      outpointParts.length > 2 ||
      !/^[0-9a-fA-F]{64}$/.test(txid) ||
      !/^(?:0|[1-9]\d*)$/.test(outputIndex) ||
      Number(outputIndex) > 0xffffffff
    ) {
      throw new Error(`Invalid certificate revocation outpoint: ${this.revocationOutpoint}`)
    }
    const txidBytes = UtilsToArray(txid, 'hex')
    if (txidBytes.length !== 32) {
      throw new Error(`Invalid certificate revocation txid length: ${txidBytes.length}`)
    }
    writer.write(txidBytes)
    writer.writeVarIntNum(Number(outputIndex))

    // Write fields
    // Preserve the historical host-locale presentation order. This ordering is
    // covered by the signature and must not be treated as semantically interchangeable.
    const fields = snapshotCertificateFields(this.fields)
    const fieldNames = Object.keys(fields).sort((a, b) => a.localeCompare(b))
    writer.writeVarIntNum(fieldNames.length)
    for (const fieldName of fieldNames) {
      const fieldValue = fields[fieldName]

      // Field name
      const fieldNameBytes = UtilsToArray(fieldName, 'utf8')
      assertCertificateFieldName(fieldName, fieldNameBytes.length)
      writer.writeVarIntNum(fieldNameBytes.length)
      writer.write(fieldNameBytes)

      // Field value
      const fieldValueBytes = UtilsToArray(fieldValue, 'utf8')
      writer.writeVarIntNum(fieldValueBytes.length)
      writer.write(fieldValueBytes)
    }

    // Write signature if included
    if (includeSignature && (this.signature ?? '').length > 0) {
      // ✅ Explicitly handle nullish signature
      if (
        typeof this.signature !== 'string' ||
        this.signature.length > MAX_CERTIFICATE_SIGNATURE_BYTES * 2 ||
        !/^(?:[0-9a-fA-F]{2})+$/.test(this.signature)
      ) {
        throw new Error('Invalid certificate signature encoding')
      }
      const signatureBytes = UtilsToArray(this.signature as string, 'hex') // ✅ Type assertion ensures it's a string
      Signature.fromDER(signatureBytes)
      writer.write(signatureBytes)
    }

    const result = writer.toArray()
    if (result.length > MAX_CERTIFICATE_BINARY_BYTES) {
      throw new Error(
        `Certificate binary exceeds the maximum of ${MAX_CERTIFICATE_BINARY_BYTES} bytes`
      )
    }
    return result
  }

  /**
   * Deserializes a certificate from binary format.
   *
   * @param {number[]} bin - The binary data representing the certificate.
   * @returns {Certificate} - The deserialized Certificate object.
   */
  static fromBinary(bin: number[] | Uint8Array): Certificate {
    const reader = new ReaderUint8Array(snapshotCertificateBinary(bin))

    // Read type
    const typeBytes = reader.read(32)
    const type = toBase64(typeBytes)

    // Read serialNumber
    const serialNumberBytes = reader.read(32)
    const serialNumber = toBase64(serialNumberBytes)

    // Read subject (33 bytes)
    const subjectBytes = reader.read(33)
    assertCompressedPublicKey(Array.from(subjectBytes), 'subject')
    const subject = toHex(subjectBytes)

    // Read certifier (33 bytes)
    const certifierBytes = reader.read(33)
    assertCompressedPublicKey(Array.from(certifierBytes), 'certifier')
    const certifier = toHex(certifierBytes)

    // Read revocationOutpoint
    const txidBytes = reader.read(32)
    const txid = toHex(txidBytes)
    const outputIndex = reader.readVarIntNumStrict(false)
    const revocationOutpoint = `${txid}.${outputIndex}`

    // Read fields
    const numFields = reader.readVarIntNumStrict(false)
    if (numFields > MAX_CERTIFICATE_FIELDS) {
      throw new Error(`Certificate field count exceeds the maximum of ${MAX_CERTIFICATE_FIELDS}`)
    }
    if (numFields > Math.floor(reader.remaining() / 3)) {
      throw new Error('Certificate field count exceeds the available data')
    }
    const fields = new Map<CertificateFieldNameUnder50Bytes, string>()
    for (let i = 0; i < numFields; i++) {
      // Field name
      const fieldNameLength = reader.readVarIntNumStrict(false)
      if (fieldNameLength < 1 || fieldNameLength > 50) {
        throw new Error(`Invalid certificate field name length: received ${fieldNameLength}`)
      }
      const fieldNameBytes = reader.read(fieldNameLength)
      const fieldName = toUTF8Strict(fieldNameBytes)
      assertCertificateFieldName(fieldName, fieldNameLength)
      if (fields.has(fieldName)) throw new Error(`Duplicate certificate field name: ${fieldName}`)

      // Field value
      const fieldValueLength = reader.readVarIntNumStrict(false)
      if (fieldValueLength > MAX_CERTIFICATE_FIELD_VALUE_BYTES) {
        throw new Error(
          `Certificate field ${fieldName} exceeds the maximum of ${MAX_CERTIFICATE_FIELD_VALUE_BYTES} bytes`
        )
      }
      const fieldValueBytes = reader.read(fieldValueLength)
      const fieldValue = toUTF8Strict(fieldValueBytes)

      fields.set(fieldName, fieldValue)
    }

    // Read signature if present
    let signature: string | undefined
    if (!reader.eof()) {
      if (reader.remaining() > MAX_CERTIFICATE_SIGNATURE_BYTES) {
        throw new Error('Certificate signature exceeds the DER size limit')
      }
      const signatureBytes = reader.read()
      const sig = Signature.fromDER(Array.from(signatureBytes))
      signature = sig.toString('hex') as string
    }

    return new Certificate(
      type,
      serialNumber,
      subject,
      certifier,
      revocationOutpoint,
      Object.fromEntries(fields),
      signature
    )
  }

  /**
   * Verifies the certificate's signature only.
   *
   * This method verifies the certificate signature and fields supplied to it;
   * it does not establish that {@link revocationOutpoint} is the correct
   * revocation token or remains unspent. A relying party may place that claim
   * inside its trust in the certifier. If it does not, it must independently
   * authenticate the applicable outpoint and obtain a current unspent verdict
   * from its own chain source. Signature validity alone is not current
   * certificate validity.
   *
   * Existing types of 1–128 decoded bytes use the original historical preimage
   * and type/serial key derivation. This does not make the type BRC-52 compliant
   * or permit new issuance; canonical binary export remains strictly 32 bytes.
   *
   * @returns {Promise<boolean>} - A promise that resolves to true if the signature is valid;
   * it makes no revocation-status assertion.
   */
  async verify(): Promise<boolean> {
    try {
      const typeBytes = existingCertificateTypeBytes(this.type)
      // Retain the established canonical export hook for 32-byte certificates.
      const verificationData =
        typeBytes.length === 32 ? this.toBinary(false) : this.#serialize(false, true)
      const certifierKey = PublicKey.fromString(this.certifier).deriveChild(
        new BigNumber(1) as PrivateKey,
        `2-certificate signature-${this.type} ${this.serialNumber}`
      )
      return certifierKey.verify(
        verificationData,
        Signature.fromDER(UtilsToArray(this.signature ?? '', 'hex'))
      )
    } catch {
      // Preserve the historical boolean verification contract. Malformed or
      // absent signatures are invalid credentials, not exceptional control flow.
      return false
    }
  }

  /**
   * Signs the certificate using the provided certifier wallet.
   *
   * @param {Wallet} certifierWallet - The wallet representing the certifier.
   * @returns {Promise<void>}
   */
  async sign(certifierWallet: ProtoWallet): Promise<void> {
    if (this.signature != null && this.signature.length > 0) {
      // ✅ Explicitly checking for null/undefined
      throw new Error(`Certificate has already been signed! Signature present: ${this.signature}`)
    }

    // Ensure the certifier declared is the one actually signing
    this.certifier = (await certifierWallet.getPublicKey({ identityKey: true })).publicKey

    const preimage = this.toBinary(false) // Exclude the signature when signing
    const { signature } = await certifierWallet.createSignature({
      data: preimage,
      protocolID: [2, 'certificate signature'],
      keyID: `${this.type} ${this.serialNumber}`
    })
    if (!equalBytes(preimage, this.toBinary(false))) {
      throw new Error('Certificate changed while its signature was being created')
    }
    const signatureBytes = snapshotCertificateBinary(signature)
    const parsedSignature = Signature.fromDER(signatureBytes)
    this.signature = parsedSignature.toString('hex') as HexString
  }

  /**
   * Helper function which retrieves the protocol ID and key ID for certificate field encryption.
   *
   * For master certificate creation, no serial number is provided because entropy is required
   * from both the client and the certifier. In this case, the `keyID` is simply the `fieldName`.
   *
   * For VerifiableCertificates verifier keyring creation, both the serial number and field name are available,
   * so the `keyID` is formed by concatenating the `serialNumber` and `fieldName`.
   *
   * @param fieldName - The name of the field within the certificate to be encrypted.
   * @param serialNumber - (Optional) The serial number of the certificate.
   * @returns An object containing:
   *   - `protocolID` (WalletProtocol): The protocol ID for certificate field encryption.
   *   - `keyID` (string): A unique key identifier. It is the `fieldName` if `serialNumber` is undefined,
   *     otherwise it is a combination of `serialNumber` and `fieldName`.
   */
  static getCertificateFieldEncryptionDetails(
    fieldName: string,
    serialNumber?: string
  ): { protocolID: WalletProtocol; keyID: string } {
    return {
      protocolID: [2, 'certificate field encryption'],
      keyID: serialNumber ? `${serialNumber} ${fieldName}` : fieldName
    }
  }

  /**
   * Creates a Certificate instance from a plain object representation.
   *
   * @param obj - The object containing certificate data.
   * @returns A new Certificate instance.
   */
  static fromObject(obj: {
    type: Base64String
    serialNumber: Base64String
    subject: PubKeyHex
    certifier: PubKeyHex
    revocationOutpoint: OutpointString
    fields: Record<CertificateFieldNameUnder50Bytes, Base64String>
    signature?: HexString
  }): Certificate {
    const cert = new Certificate(
      obj.type,
      obj.serialNumber,
      obj.subject,
      obj.certifier,
      obj.revocationOutpoint,
      obj.fields,
      obj.signature
    )

    return cert
  }
}
