import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { toArray } from '@bsv/sdk/primitives/utils'
import { argon2id } from '../../utility/hashWasm'
import { readyArgon2idBackend } from '../../utility/Argon2idBackend'
import type { Brc39StreamHeader, Brc39StreamPolicy } from './Brc39Frame'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc39OwnedBrowserKeyOptions {
  readonly policy: Brc39StreamPolicy
  readonly expiresAt: number
  readonly maximumPasswordBytes: number
  readonly maximumOperationMilliseconds: number
  readonly cleanupMilliseconds: number
  /** Refuse a cold/missing optional backend instead of running on the UI thread. */
  readonly requireReadyAsyncBackend?: boolean
  readonly signal?: AbortSignal
}
function bound(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError('Invalid owned browser KDF bound')
}
async function wait(pending: Promise<void>, milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (milliseconds <= 0) throw new SnapshotResourceLimitError('Owned browser KDF original calendar ended')
  const deadline = Date.now() + milliseconds,
    began = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('Owned browser KDF calendar ended')),
          milliseconds
        )
        if (signal !== undefined) {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }
      })
    ])
    if (Date.now() >= deadline || performance.now() - began >= milliseconds)
      throw new SnapshotResourceLimitError('Owned browser KDF calendar ended')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal!.removeEventListener('abort', abort)
  }
}
/** Owns the actual noncancelable Argon2id promise. Failure revokes key delivery;
 * late output is erased. A stalled backend retains its original buffers and
 * cleanup promise instead of pretending a Promise.race cancelled the backend.
 * Successful output is a fresh raw buffer the caller must consume and erase. */
export async function deriveBrc39OwnedBrowserKey(
  header: Brc39StreamHeader,
  password: string,
  selected: Brc39OwnedBrowserKeyOptions
): Promise<Uint8Array> {
  const policy = Object.freeze({ ...selected.policy }),
    expiresAt = selected.expiresAt,
    passwordLimit = selected.maximumPasswordBytes,
    operationLimit = selected.maximumOperationMilliseconds,
    cleanupLimit = selected.cleanupMilliseconds,
    signal = selected.signal,
    requireAsync = selected.requireReadyAsyncBackend === true,
    iterations = header.iterations,
    memoryKiB = header.memoryKiB,
    parallelism = header.parallelism
  bound(expiresAt, Number.MAX_SAFE_INTEGER)
  bound(passwordLimit, 65536)
  bound(operationLimit, 30000)
  bound(cleanupLimit, 30000)
  bound(policy.maximumIterations, 0xffffffff)
  bound(policy.maximumMemoryKiB, 0xffffffff)
  bound(policy.maximumParallelism, 255)
  bound(iterations, policy.maximumIterations)
  bound(memoryKiB, policy.maximumMemoryKiB)
  bound(parallelism, policy.maximumParallelism)
  signal?.throwIfAborted()
  const backend = readyArgon2idBackend(!requireAsync)
  if (requireAsync && backend === undefined)
    throw new Error('Browser KDF requires a preloaded asynchronous worker/native backend')
  if (typeof password !== 'string' || password.length > passwordLimit)
    throw new SnapshotResourceLimitError('Owned browser password bound reached')
  const normalized = password.normalize('NFC')
  if (normalized.length > passwordLimit)
    throw new SnapshotResourceLimitError('Owned browser normalized password bound reached')
  const bytes = new Uint8Array(toArray(normalized, 'utf8'))
  let salt: Uint8Array | undefined,
    abandoned = false,
    pending: Promise<void> | undefined
  const result: { key?: Uint8Array } = {}
  const began = performance.now(),
    lifetime = expiresAt - Date.now()
  const erase = () => {
    bytes.fill(0)
    salt?.fill(0)
    result.key?.fill(0)
    result.key = undefined
  }
  try {
    if (bytes.byteLength > passwordLimit)
      throw new SnapshotResourceLimitError('Owned browser UTF8 password bound reached')
    if (lifetime <= 0) throw new SnapshotResourceLimitError('Owned browser KDF original lifetime ended')
    salt = detachBrc38PrivateChunk(header.salt, 255)
    if (salt.byteLength === 0) throw new TypeError('Owned browser KDF requires its original salt')
    const ownedSalt = salt
    pending = Promise.resolve()
      .then(async () => {
        signal?.throwIfAborted()
        if (Date.now() >= expiresAt || performance.now() - began >= lifetime)
          throw new SnapshotResourceLimitError('Owned browser KDF original lifetime ended')
        const parameters = Object.freeze({
          password: bytes,
          salt: ownedSalt,
          iterations,
          memorySize: memoryKiB,
          parallelism,
          hashLength: 32
        })
        const derived =
          backend === undefined
            ? await argon2id({ ...parameters, outputType: 'binary' })
            : await backend.deriveKey(parameters)
        if (!(derived instanceof Uint8Array)) throw new TypeError('Owned browser KDF returned an invalid raw key')
        if (derived.byteLength !== 32) {
          derived.fill(0)
          throw new TypeError('Owned browser KDF returned an invalid key length')
        }
        if (abandoned) derived.fill(0)
        else result.key = derived
      })
      .finally(() => {
        bytes.fill(0)
        ownedSalt.fill(0)
      })
    void pending.catch(() => {})
    await wait(pending, Math.min(operationLimit, lifetime), signal)
    signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() - began >= lifetime || result.key === undefined)
      throw new SnapshotResourceLimitError('Owned browser KDF original delivery lifetime ended')
    const owned = result.key
    result.key = undefined
    return owned
  } catch (cause) {
    abandoned = true
    result.key?.fill(0)
    result.key = undefined
    if (pending !== undefined) {
      const actual = pending
      const cleanup = () =>
        mapAwaitFromSync(
          () =>
            wait(
              actual.then(
                () => {},
                () => {}
              ),
              cleanupLimit
            ),
          () => {
            erase()
          }
        )
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Owned browser KDF retains actual backend settlement and erasure',
          cleanup
        )
      }
    } else erase()
    throw cause
  }
}
