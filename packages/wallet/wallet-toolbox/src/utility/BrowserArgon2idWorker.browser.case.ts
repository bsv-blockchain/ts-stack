import { BrowserArgon2idWorkerBackend } from './BrowserArgon2idWorker'
import { registerArgon2idBackend, unregisterArgon2idBackend } from './Argon2idBackend'
import { argon2id } from './hashWasm'
import { deriveBrc39OwnedBrowserKey } from '../storage/portable/Brc39OwnedBrowserKey'

// Authored UNRUN. The host supplies the fixed independently bundled installer
// asset. Native browser foreground/resource results require fresh qualification.
export async function verifyBrowserArgon2Worker(factory: () => Worker): Promise<void> {
  const backend = new BrowserArgon2idWorkerBackend(factory, {
      maximumPasswordBytes: 1024,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1,
      maximumMilliseconds: 30000
    }),
    header = {
      iterations: 7,
      memoryKiB: 131072,
      parallelism: 1,
      salt: new Uint8Array(32).fill(71),
      nonce: new Uint8Array(32).fill(73)
    },
    selected = {
      policy: {
        maximumFileBytes: 1048576,
        maximumChunkBytes: 4096,
        maximumIterations: 7,
        maximumMemoryKiB: 131072,
        maximumParallelism: 1
      },
      expiresAt: Date.now() + 120000,
      maximumPasswordBytes: 1024,
      maximumOperationMilliseconds: 30000,
      cleanupMilliseconds: 30000
    }
  let key: Uint8Array | undefined,
    expected: Uint8Array | undefined,
    ticks = 0,
    timer: ReturnType<typeof setInterval> | undefined
  try {
    await backend.preload()
    registerArgon2idBackend(backend)
    timer = setInterval(() => {
      ticks++
    }, 1)
    key = await deriveBrc39OwnedBrowserKey(header, 'Cafe\u0301', selected)
    clearInterval(timer)
    timer = undefined
    if (ticks === 0) throw new Error('Browser worker derivation prevented all foreground ticks')
    unregisterArgon2idBackend(backend)
    const independent = await argon2id({
      password: new TextEncoder().encode('Caf\u00e9'),
      salt: header.salt,
      iterations: 7,
      memorySize: 131072,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
    if (!(independent instanceof Uint8Array)) throw new TypeError('Independent KDF did not return bytes')
    expected = independent
    if (key.byteLength !== 32 || key.some((byte, index) => byte !== expected![index]))
      throw new Error('Browser worker NFC derivation differs')
    if (backend.isReady()) throw new Error('One-shot browser worker remained ready after delivery')
    await backend.preload()
    registerArgon2idBackend(backend)
    const controller = new AbortController(),
      reason = new Error('Browser worker cancellation case')
    const pending = deriveBrc39OwnedBrowserKey(header, 'private', { ...selected, signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(reason)
    let caught: unknown
    try {
      const unwanted = await pending
      unwanted.fill(0)
    } catch (cause) {
      caught = cause
    }
    if (caught !== reason) throw new Error('Browser worker cancellation did not preserve its exact cause')
  } finally {
    if (timer !== undefined) clearInterval(timer)
    key?.fill(0)
    expected?.fill(0)
    unregisterArgon2idBackend(backend)
    await backend.retryCleanup()
    await backend.close()
  }
}
