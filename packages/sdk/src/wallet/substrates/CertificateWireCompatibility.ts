import Certificate from '../../auth/certificates/Certificate.js'
import {
  ReaderUint8Array,
  WriterUint8Array,
  toBase64,
  toUTF8Strict,
  toArray
} from '../../primitives/utils.js'
import { base64ToBytes } from '../WalletByteEncoding.js'
import { existingCertificateTypeBytes } from '../CertificateType.js'

// SHA-256 of the UTF-8 domain strings documented in the protocol specification.
export const CERTIFICATE_TYPE_MARKER = 'JiQBZT2zOAmBpxBObV9OZN8xfnQVUchmRkCh6FcEV1M='
export const CERTIFICATE_TYPE_FIELD = '4Oe/4ZEhACaZke7QFsgoLaJytNQ8Cg8165Yw6ybtLvg='
export const CERTIFICATE_COMPATIBILITY_CALL = 29
export const CERTIFICATE_COMPATIBILITY_VERSION = 1
export const COMPATIBLE_CERTIFICATE_CALLS: ReadonlySet<number> = new Set([18, 19, 20, 21, 22])

export function writeCertificateType(
  writer: WriterUint8Array,
  type: string,
  compatibility: boolean
): void {
  // Request references retain the existing argument validator's trimming.
  // Signed certificate types and response metadata are never normalized.
  type = type.trim()
  const bytes = existingCertificateTypeBytes(type)
  if (compatibility && (bytes.length !== 32 || type === CERTIFICATE_TYPE_MARKER)) {
    writer.write(base64ToBytes(CERTIFICATE_TYPE_MARKER))
    writer.writeVarIntNum(bytes.length)
  } else if (bytes.length !== 32) {
    throw new Error('Wallet does not support legacy certificate types over binary wire')
  }
  writer.write(bytes)
}

export function readCertificateType(reader: ReaderUint8Array, compatibility: boolean): string {
  const type = toBase64(reader.read(32))
  if (!compatibility || type !== CERTIFICATE_TYPE_MARKER) return type
  const length = reader.readVarIntNumStrict(false)
  if (length < 1 || length > 128) throw new Error('Invalid escaped certificate type length')
  const original = toBase64(reader.read(length))
  if (length === 32 && original !== CERTIFICATE_TYPE_MARKER) {
    throw new Error('Non-canonical escaped certificate type')
  }
  return original
}

export function encodeWireCertificate(certificate: Certificate, compatibility: boolean): number[] {
  const bytes = existingCertificateTypeBytes(certificate.type)
  if (!compatibility || (bytes.length === 32 && certificate.type !== CERTIFICATE_TYPE_MARKER)) {
    return certificate.toBinary()
  }
  // A versioned tuple preserves a genuine signed field occupying the metadata key.
  // It is never a keyring entry or a signed field of the logical certificate.
  const original = Object.hasOwn(certificate.fields, CERTIFICATE_TYPE_FIELD)
    ? certificate.fields[CERTIFICATE_TYPE_FIELD]
    : null
  const metadata = toBase64(toArray(JSON.stringify([1, certificate.type, original]), 'utf8'))
  const fields = { ...certificate.fields, [CERTIFICATE_TYPE_FIELD]: metadata }
  return new Certificate(
    CERTIFICATE_TYPE_MARKER,
    certificate.serialNumber,
    certificate.subject,
    certificate.certifier,
    certificate.revocationOutpoint,
    fields,
    certificate.signature
  ).toBinary()
}

export function decodeWireCertificate(
  bytes: number[] | Uint8Array,
  compatibility: boolean
): Certificate {
  const certificate = Certificate.fromBinary(bytes)
  if (!compatibility || certificate.type !== CERTIFICATE_TYPE_MARKER) return certificate
  const encoded = certificate.fields[CERTIFICATE_TYPE_FIELD]
  if (typeof encoded !== 'string') throw new Error('Missing legacy certificate type metadata')
  const metadata: unknown = JSON.parse(toUTF8Strict(base64ToBytes(encoded)))
  if (
    !Array.isArray(metadata) ||
    metadata.length !== 3 ||
    metadata[0] !== 1 ||
    (metadata[2] !== null && typeof metadata[2] !== 'string')
  ) {
    throw new Error('Invalid legacy certificate type metadata')
  }
  const original = metadata[1]
  const typeBytes = existingCertificateTypeBytes(original)
  if (typeBytes.length === 32 && original !== CERTIFICATE_TYPE_MARKER) {
    throw new Error('Non-canonical legacy certificate metadata')
  }
  certificate.type = original as string
  // Retain the parsed position of a displaced real key. Moving it to the end
  // can change historical stable collation when another name compares equal.
  certificate.fields = Object.fromEntries(
    Object.entries(certificate.fields)
      .filter(([name]) => name !== CERTIFICATE_TYPE_FIELD || metadata[2] !== null)
      .map(([name, value]) => [name, name === CERTIFICATE_TYPE_FIELD ? metadata[2] : value])
  )
  return certificate
}

/** Parse profile selection before dispatch, without connection-global state. */
export function readCertificateCompatibility(
  reader: ReaderUint8Array,
  callCode: number
): { operation: number; compatibility: boolean; probe: boolean } {
  if (callCode !== CERTIFICATE_COMPATIBILITY_CALL) {
    return { operation: callCode, compatibility: false, probe: false }
  }
  const mode = reader.readUInt8()
  const version = reader.readUInt8()
  if (version !== CERTIFICATE_COMPATIBILITY_VERSION)
    throw new Error('Unsupported certificate compatibility version')
  if (mode === 0) {
    if (!reader.eof())
      throw new Error('Wallet Wire certificate compatibility probe request contains trailing data')
    return { operation: callCode, compatibility: false, probe: true }
  }
  if (mode !== 1) throw new Error('Invalid certificate compatibility mode')
  const operation = reader.readUInt8()
  if (!COMPATIBLE_CERTIFICATE_CALLS.has(operation))
    throw new Error('Invalid certificate compatibility operation')
  return { operation, compatibility: true, probe: false }
}
