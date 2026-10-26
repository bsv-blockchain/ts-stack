import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { getHashFromURL, getURLForHash } from '@bsv/sdk/storage/StorageUtils'
import { CHIRPError } from './errors.js'

const HASH_UPDATE_BYTES = 64 * 1024

export function sha256(bytes: Uint8Array): Uint8Array {
  assertBytes(bytes)
  const hasher = new SHA256()
  updateHasher(hasher, bytes)
  return Uint8Array.from(hasher.digest())
}

export function createSHA256(): {
  update(bytes: Uint8Array): void
  digest(): Uint8Array
} {
  const hasher = new SHA256()
  let result: Uint8Array | undefined
  return {
    update(bytes) {
      if (result !== undefined) throw new Error('SHA-256 context is already finalized.')
      assertBytes(bytes)
      updateHasher(hasher, bytes)
    },
    digest() {
      result ??= Uint8Array.from(hasher.digest())
      return result.slice()
    }
  }
}

function updateHasher(hasher: SHA256, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_UPDATE_BYTES) {
    hasher.update(Array.from(bytes.subarray(offset, offset + HASH_UPDATE_BYTES)))
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  assertBytes(left)
  assertBytes(right)
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export function objectIdentifierForHash(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) {
    throw new CHIRPError('ERR_CHIRP_HASH_LENGTH', 'CHIRP object hashes must contain 32 bytes.')
  }
  return getURLForHash(Array.from(hash))
}

export function objectIdentifierForBytes(bytes: Uint8Array): string {
  return objectIdentifierForHash(sha256(bytes))
}

export function hashForObjectIdentifier(identifier: string): Uint8Array {
  if (typeof identifier !== 'string') {
    throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid BRC-26 object identifier.')
  }
  try {
    const hash = Uint8Array.from(getHashFromURL(identifier))
    if (hash.byteLength !== 32 || objectIdentifierForHash(hash) !== identifier) {
      throw new Error('Object identifier is not canonical.')
    }
    return hash
  } catch (cause) {
    throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid BRC-26 object identifier.', {
      cause: cause instanceof Error ? cause : undefined
    })
  }
}

export function verifyObjectBytes(identifier: string, bytes: Uint8Array): void {
  assertBytes(bytes)
  if (!equalBytes(hashForObjectIdentifier(identifier), sha256(bytes))) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_HASH', `Object bytes do not match ${identifier}.`)
  }
}

export function hashHex(hash: Uint8Array): string {
  assertBytes(hash)
  return toHex(Array.from(hash))
}

function assertBytes(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array bytes.')
}
