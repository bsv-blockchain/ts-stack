import { Brc39WebCryptoGcm } from './Brc39WebCryptoGcm'
import { deriveBrc39OwnedBrowserKey } from './Brc39OwnedBrowserKey'
import {
  encodeBrc39StreamPrefix,
  BRC39_STREAM_DEFAULT_KDF,
  type Brc39StreamKdf,
  type Brc39StreamPolicy
} from './Brc39Frame'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc39BrowserStreamPlaintext {
  chunks: AsyncIterable<Uint8Array>
  /** Independent complete coherent BRC-38 semantics, not a crypto receipt. */
  validateCompleted: () => Promise<void>
  /** Await original source I/O; idempotent if present. */
  close?: () => Promise<void>
}
export interface Brc39BrowserStreamOutput {
  /** Detach before settling and keep partial output private. */
  appendUntrusted: (bytes: Uint8Array) => Promise<void>
  /** Await all actual output I/O and erase unpublished output; idempotent. */
  discard: () => Promise<void>
}
export interface Brc39BrowserEncryptOptions {
  readonly policy: Brc39StreamPolicy
  readonly maximumPasswordBytes: number
  readonly maximumPlaintextBytes: number
  /** Crypto scratch only; Argon2 and source/output have separate budgets. */
  readonly maximumCryptoAllocationBytes: number
  readonly expiresAt: number
  readonly maximumKdfMilliseconds: number
  readonly cleanupMilliseconds: number
  readonly kdf?: Brc39StreamKdf
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: Readonly<{ fileBytes: number; plaintextBytes: number }>) => void
}
function bound(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError('Invalid browser BRC-39 export bound')
}
/** Size-independent browser export using native AES-CTR and the existing SDK
 * GHASH accumulator. Preserves NFC, canonical strength, 32-byte random salt/IV,
 * no AAD and the exact BRC-39 envelope. The same GHASH shared-CPU limitations as
 * browser streaming import apply; this is authored, not platform qualification.
 * Only a completed source validation and actual source/crypto drain permit the
 * tag. Hosts own durable publication and must retain independent key recovery. */
export async function encryptBrc39BrowserStreamToQuarantine(
  source: Brc39BrowserStreamPlaintext,
  password: string,
  output: Brc39BrowserStreamOutput,
  selected: Brc39BrowserEncryptOptions
): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> {
  const policy = Object.freeze({ ...selected.policy }),
    kdf = Object.freeze({ ...(selected.kdf ?? BRC39_STREAM_DEFAULT_KDF) }),
    passwordBytes = selected.maximumPasswordBytes,
    plaintextLimit = selected.maximumPlaintextBytes,
    allocation = selected.maximumCryptoAllocationBytes,
    expiresAt = selected.expiresAt,
    kdfLimit = selected.maximumKdfMilliseconds,
    cleanupLimit = selected.cleanupMilliseconds,
    signal = selected.signal,
    onProgress = selected.onProgress,
    began = performance.now(),
    lifetime = expiresAt - Date.now()
  let owner: Brc39WebCryptoGcm | undefined,
    key: Uint8Array | undefined,
    tail: Uint8Array | undefined,
    tag: Uint8Array | undefined
  let fileBytes = 0,
    plaintextBytes = 0,
    sourceClosed = false,
    outputDiscarded = false
  const retained = new Set<Brc38StagingCleanupError>()
  const check = () => {
    signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Browser BRC-39 export original lifetime ended')
  }
  const cleanup = async () => {
    const failures: unknown[] = []
    key?.fill(0)
    key = undefined
    tail?.fill(0)
    tail = undefined
    tag?.fill(0)
    tag = undefined
    for (const error of retained)
      try {
        await error.retryCleanup()
        retained.delete(error)
      } catch (cause) {
        failures.push(cause)
      }
    try {
      await owner?.close()
      owner = undefined
    } catch (cause) {
      failures.push(cause)
    }
    try {
      if (!sourceClosed) {
        await source.close?.()
        sourceClosed = true
      }
    } catch (cause) {
      failures.push(cause)
    }
    try {
      if (!outputDiscarded) {
        await output.discard()
        outputDiscarded = true
      }
    } catch (cause) {
      failures.push(cause)
    }
    for (const cause of failures) if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
    if (failures.length !== 0)
      throw new Brc38StagingCleanupError(failures, 'Browser BRC-39 export retains actual cleanup', cleanup)
  }
  const progress = () => Object.freeze({ fileBytes, plaintextBytes })
  async function write(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += policy.maximumChunkBytes) {
      check()
      const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + policy.maximumChunkBytes))
      try {
        if (chunk.byteLength > policy.maximumFileBytes - fileBytes)
          throw new SnapshotResourceLimitError('Browser BRC-39 export file bound reached')
        await output.appendUntrusted(chunk)
        fileBytes += chunk.byteLength
        check()
      } finally {
        chunk.fill(0)
      }
    }
  }
  try {
    bound(passwordBytes, 65536)
    bound(plaintextLimit, 16 * (2 ** 32 - 2))
    bound(allocation, 16777216)
    bound(expiresAt, Number.MAX_SAFE_INTEGER)
    bound(kdfLimit, 30000)
    bound(cleanupLimit, 30000)
    if (policy.maximumChunkBytes < 16 || allocation < 65536 || allocation < 16384 + 16 * policy.maximumChunkBytes)
      throw new SnapshotResourceLimitError('Browser BRC-39 export crypto allocation bound reached')
    check()
    if (typeof Crypto === 'undefined' || globalThis.crypto?.subtle === undefined)
      throw new Error('Browser BRC-39 export requires native WebCrypto and secure randomness')
    const salt = new Uint8Array(32),
      nonce = new Uint8Array(32)
    Reflect.apply(Crypto.prototype.getRandomValues, globalThis.crypto, [salt])
    Reflect.apply(Crypto.prototype.getRandomValues, globalThis.crypto, [nonce])
    const prefix = encodeBrc39StreamPrefix(kdf, salt, nonce, policy)
    key = await deriveBrc39OwnedBrowserKey({ ...kdf, salt, nonce }, password, {
      policy,
      expiresAt,
      maximumPasswordBytes: passwordBytes,
      maximumOperationMilliseconds: kdfLimit,
      cleanupMilliseconds: cleanupLimit,
      requireReadyAsyncBackend: true,
      signal
    })
    check()
    owner = await Brc39WebCryptoGcm.createEncryptor(key, nonce, {
      maximumChunkBytes: policy.maximumChunkBytes,
      maximumPlaintextBytes: plaintextLimit,
      maximumAllocationBytes: allocation,
      expiresAt,
      cleanupMilliseconds: cleanupLimit,
      signal
    })
    key.fill(0)
    key = undefined
    await write(prefix)
    for await (const input of source.chunks) {
      check()
      if (!(input instanceof Uint8Array) || input.byteLength > policy.maximumChunkBytes)
        throw new TypeError('Browser BRC-39 plaintext requires bounded byte chunks')
      const inputBytes = input.byteLength
      if (inputBytes > plaintextLimit - plaintextBytes || inputBytes > policy.maximumFileBytes - 113 - plaintextBytes)
        throw new SnapshotResourceLimitError('Browser BRC-39 plaintext/file byte bound reached')
      const ciphertext = await owner.update(input)
      try {
        await write(ciphertext)
      } finally {
        ciphertext.fill(0)
      }
      plaintextBytes += inputBytes
      onProgress?.(progress())
      check()
    }
    if (plaintextBytes === 0) throw new TypeError('Browser BRC-39 plaintext stream is empty')
    const finished = await owner.finishEncryption()
    tail = finished.ciphertext
    tag = finished.tag
    await write(tail)
    tail.fill(0)
    tail = undefined
    await owner.close()
    owner = undefined
    check()
    await source.validateCompleted()
    check()
    await source.close?.()
    sourceClosed = true
    check()
    await write(tag)
    tag.fill(0)
    tag = undefined
    if (fileBytes !== plaintextBytes + 113) throw new Error('Browser BRC-39 complete output extent differs')
    const result = progress()
    onProgress?.(result)
    check()
    return result
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError([cause, error_], 'Browser BRC-39 export failed with retained cleanup', cleanup)
    }
    throw cause
  }
}
