import { Hash, StorageUtils, Utils } from '@bsv/sdk'
import { CHIRPError } from './errors.js'

const HASH_UPDATE_BYTES = 64 * 1024

export function sha256(bytes: Uint8Array): Uint8Array {
  const hasher = new Hash.SHA256()
  updateHasher(hasher, bytes)
  return Uint8Array.from(hasher.digest())
}

export function createSHA256(): {
  update(bytes: Uint8Array): void
  digest(): Uint8Array
} {
  const hasher = new Hash.SHA256()
  return {
    update(bytes) {
      updateHasher(hasher, bytes)
    },
    digest() {
      return Uint8Array.from(hasher.digest())
    }
  }
}

function updateHasher(hasher: Hash.SHA256, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_UPDATE_BYTES) {
    hasher.update(Array.from(bytes.subarray(offset, offset + HASH_UPDATE_BYTES)))
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export function objectIdentifierForHash(hash: Uint8Array): string {
  if (hash.byteLength !== 32) {
    throw new CHIRPError('ERR_CHIRP_HASH_LENGTH', 'CHIRP object hashes must contain 32 bytes.')
  }
  return StorageUtils.getURLForHash(Array.from(hash))
}

export function objectIdentifierForBytes(bytes: Uint8Array): string {
  return objectIdentifierForHash(sha256(bytes))
}

export function hashForObjectIdentifier(identifier: string): Uint8Array {
  try {
    return Uint8Array.from(StorageUtils.getHashFromURL(identifier))
  } catch (cause) {
    throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid BRC-26 object identifier.', {
      cause: cause instanceof Error ? cause : undefined
    })
  }
}

export function verifyObjectBytes(identifier: string, bytes: Uint8Array): void {
  if (!equalBytes(hashForObjectIdentifier(identifier), sha256(bytes))) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_HASH', `Object bytes do not match ${identifier}.`)
  }
}

export function hashHex(hash: Uint8Array): string {
  return Utils.toHex(Array.from(hash))
}
