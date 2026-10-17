import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc39OwnedBrowserEnvelopeOptions {
  readonly maximumPayloadBytes: number
  readonly expiresAt: number
  readonly cleanupMilliseconds: number
  readonly signal?: AbortSignal
}
interface Calendar {
  readonly wall: number
  readonly began: number
  readonly milliseconds: number
}
async function wait(pending: Promise<void>, selected: Calendar, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const remaining = Math.min(selected.wall - Date.now(), selected.milliseconds - (performance.now() - selected.began))
  if (remaining <= 0) throw new SnapshotResourceLimitError('Owned browser envelope calendar ended')
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('Owned browser envelope calendar ended')),
          remaining
        )
        if (signal !== undefined) {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal!.removeEventListener('abort', abort)
  }
}

/** Whole-message native AES-GCM for the separately admitted SMALL envelope.
 * Every native promise is retained until it settles. Cancellation/timeout
 * revokes delivery and erases late plaintext; a failed drain carries its actual
 * retry owner. Caller must already reserve whole-envelope preparation memory.
 * Neither Promise.race nor dropping CryptoKey constitutes native cancellation. */
export async function decryptBrc39OwnedBrowserEnvelope(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  payload: Uint8Array,
  selected: Brc39OwnedBrowserEnvelopeOptions
): Promise<Uint8Array<ArrayBuffer>> {
  const options = Object.freeze({ ...selected }),
    began = performance.now(),
    lifetime = options.expiresAt - Date.now()
  if (
    !Number.isSafeInteger(options.maximumPayloadBytes) ||
    options.maximumPayloadBytes < 17 ||
    options.maximumPayloadBytes > 16777216 ||
    !Number.isSafeInteger(options.cleanupMilliseconds) ||
    options.cleanupMilliseconds < 1 ||
    options.cleanupMilliseconds > 30000 ||
    !Number.isSafeInteger(options.expiresAt) ||
    options.expiresAt < 1
  )
    throw new RangeError('Invalid owned browser envelope bounds')
  if (typeof SubtleCrypto === 'undefined' || globalThis.crypto?.subtle === undefined)
    throw new Error('Owned browser envelope requires native WebCrypto')
  const subtle = globalThis.crypto.subtle,
    importKey = SubtleCrypto.prototype.importKey,
    decrypt = SubtleCrypto.prototype.decrypt
  let abandoned = false,
    pending: Promise<void> | undefined,
    raw: Uint8Array | undefined,
    iv: Uint8Array | undefined,
    cipher: Uint8Array | undefined
  const check = () => {
    options.signal?.throwIfAborted()
    if (abandoned || Date.now() >= options.expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Owned browser envelope original lifetime ended')
  }
  async function operation<T>(invoke: () => Promise<T>, erase: (value: T) => void): Promise<T> {
    check()
    if (pending !== undefined) throw new Error('Owned browser envelope already owns native work')
    const state: { value?: { actual: T } } = {}
    pending = Promise.resolve()
      .then(async () => {
        check()
        return await invoke()
      })
      .then(value => {
        if (abandoned) erase(value)
        else state.value = { actual: value }
      })
    void pending.catch(() => {})
    const milliseconds = Math.min(30000, options.expiresAt - Date.now(), lifetime - (performance.now() - began))
    try {
      await wait(pending, { wall: Date.now() + milliseconds, began: performance.now(), milliseconds }, options.signal)
      check()
      if (state.value === undefined) throw new Error('Owned browser envelope native result was revoked')
      pending = undefined
      return state.value.actual
    } catch (cause) {
      abandoned = true
      if (state.value !== undefined) {
        erase(state.value.actual)
        state.value = undefined
      }
      throw cause
    }
  }
  const eraseInputs = () => {
    raw?.fill(0)
    iv?.fill(0)
    cipher?.fill(0)
  }
  try {
    check()
    raw = detachBrc38PrivateChunk(keyBytes, 32)
    iv = detachBrc38PrivateChunk(nonce, 255)
    cipher = detachBrc38PrivateChunk(payload, options.maximumPayloadBytes)
    if (raw.byteLength !== 32 || iv.byteLength === 0 || cipher.byteLength < 17)
      throw new TypeError('Invalid owned browser GCM inputs')
    const originalRaw = raw,
      originalIv = iv,
      originalCipher = cipher,
      key = await operation(
        async () => {
          try {
            return (await Reflect.apply(importKey, subtle, [
              'raw',
              originalRaw,
              { name: 'AES-GCM' },
              false,
              ['decrypt']
            ])) as CryptoKey
          } finally {
            originalRaw.fill(0)
          }
        },
        () => {}
      ),
      output = await operation(
        async () => {
          try {
            const value: ArrayBuffer = await Reflect.apply(decrypt, subtle, [
              { name: 'AES-GCM', iv: originalIv, tagLength: 128 },
              key,
              originalCipher
            ])
            return new Uint8Array(value)
          } finally {
            originalIv.fill(0)
            originalCipher.fill(0)
          }
        },
        value => value.fill(0)
      )
    if (output.byteLength !== originalCipher.byteLength - 16) {
      output.fill(0)
      throw new Error('Owned native GCM plaintext extent differs')
    }
    eraseInputs()
    return output
  } catch (cause) {
    abandoned = true
    const actual = pending
    const cleanup = async () => {
      if (actual !== undefined) {
        const milliseconds = options.cleanupMilliseconds
        await wait(
          actual.then(
            () => {},
            () => {}
          ),
          { wall: Date.now() + milliseconds, began: performance.now(), milliseconds }
        )
      }
      eraseInputs()
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Owned browser envelope retains actual native settlement and erasure',
        cleanup
      )
    }
    throw cause
  }
}
