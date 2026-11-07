import { concatBytes, utf8, wipe } from './bytes.js'

/** Domain-separation salt for BRC-206 HKDF-SHA256. The operation label and size live in info. */
export const RABIN_HKDF_SALT = utf8('BRC-206 p rabin v1')

/**
 * Info for one prime candidate.
 * `key` is the fixed key-generation operation, shared by the `key` and `sign` requests so both
 * derive the same factors. The modulus size is part of the info, so 2048, 3072 and 4096 never
 * share a keystream.
 */
export function rabinPrimeInfo(bits: number, primeIndex: 0 | 1, counter: number): Uint8Array {
  return utf8(`p rabin|key|${bits}|prime|${primeIndex}|ctr|${counter}`)
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    ownedBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, ownedBytes(data))
  return new Uint8Array(signature)
}

/** RFC 5869 HKDF-Extract with SHA-256. */
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm)
}

/**
 * Writes HKDF blocks in order. Each block depends on the previous one, so the
 * expansion is a chain of HMAC calls rather than a parallel loop.
 */
async function expandInto(
  prk: Uint8Array,
  info: Uint8Array,
  blocks: number,
  counter: number,
  previous: Uint8Array,
  out: Uint8Array
): Promise<void> {
  if (counter > blocks) {
    wipe(previous)
    return
  }
  const block = await hmacSha256(prk, concatBytes([previous, info, Uint8Array.of(counter)]))
  if (previous.length > 0) wipe(previous)
  out.set(block, (counter - 1) * 32)
  await expandInto(prk, info, blocks, counter + 1, block, out)
}

/** RFC 5869 HKDF-Expand with SHA-256. */
export async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 255 * 32) {
    throw new RangeError('Rabin: HKDF length is outside the SHA-256 limit')
  }
  const blocks = Math.ceil(length / 32)
  const out = new Uint8Array(blocks * 32)
  await expandInto(prk, info, blocks, 1, new Uint8Array(), out)
  const result = out.slice(0, length)
  wipe(out)
  return result
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBytes(data)))
}
