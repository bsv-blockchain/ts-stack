import { GroupMessagingError } from '../errors.js'
import type { KeyPackageBytes, PrivateKeyPackageBytes } from '../types.js'

const VERSION = 1

/** The three private keys `ts-mls` needs to create or join a group. */
export interface PrivateKeyPackageParts {
  initPrivateKey: Uint8Array
  hpkePrivateKey: Uint8Array
  signaturePrivateKey: Uint8Array
}

export const asKeyPackageBytes = (bytes: Uint8Array): KeyPackageBytes => bytes as KeyPackageBytes

export const asPrivateKeyPackageBytes = (bytes: Uint8Array): PrivateKeyPackageBytes =>
  bytes as PrivateKeyPackageBytes

/**
 * `ts-mls` provides no encoder for `PrivateKeyPackage`, so this is ours:
 * a version byte then three u16 length-prefixed keys. Versioned because a
 * wallet's stored records have to survive a format change.
 */
export const encodePrivateKeyPackage = (parts: PrivateKeyPackageParts): PrivateKeyPackageBytes => {
  const fields = [parts.initPrivateKey, parts.hpkePrivateKey, parts.signaturePrivateKey]
  const total = 1 + fields.reduce((n, field) => n + 2 + field.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out[0] = VERSION
  let offset = 1
  for (const field of fields) {
    if (field.length > 0xffff) {
      throw new GroupMessagingError(`Key of ${field.length} bytes exceeds the u16 length prefix`)
    }
    view.setUint16(offset, field.length, false)
    offset += 2
    out.set(field, offset)
    offset += field.length
  }
  return asPrivateKeyPackageBytes(out)
}

export const decodePrivateKeyPackage = (bytes: PrivateKeyPackageBytes): PrivateKeyPackageParts => {
  if (bytes.length < 1) throw new GroupMessagingError('Empty private KeyPackage')
  if (bytes[0] !== VERSION) {
    throw new GroupMessagingError(`Unsupported private KeyPackage version ${bytes[0]}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 1
  const fields: Uint8Array[] = []
  for (let index = 0; index < 3; index++) {
    if (offset + 2 > bytes.length) {
      throw new GroupMessagingError('Truncated private KeyPackage length prefix')
    }
    const length = view.getUint16(offset, false)
    offset += 2
    if (offset + length > bytes.length) {
      throw new GroupMessagingError('Truncated private KeyPackage body')
    }
    fields.push(bytes.slice(offset, offset + length))
    offset += length
  }
  if (offset !== bytes.length) {
    throw new GroupMessagingError('Trailing bytes in private KeyPackage')
  }
  const [initPrivateKey, hpkePrivateKey, signaturePrivateKey] = fields as [
    Uint8Array,
    Uint8Array,
    Uint8Array
  ]
  return { initPrivateKey, hpkePrivateKey, signaturePrivateKey }
}
