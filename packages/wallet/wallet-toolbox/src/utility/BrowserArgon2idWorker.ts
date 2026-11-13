import { promiseFromSync, awaitVoidFromSync } from './promiseFromSync'
import type { Argon2idOptions, AsyncArgon2idBackend } from './Argon2idBackend'
import { Brc38StagingCleanupError } from '../storage/portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../storage/snapshot/SnapshotResourceLimitError'

export interface BrowserArgon2idWorkerPolicy {
  readonly maximumPasswordBytes: number
  readonly maximumIterations: number
  readonly maximumMemoryKiB: number
  readonly maximumParallelism: number
  readonly maximumMilliseconds: number
}
export function browserArgon2idWorkerPolicy(value: BrowserArgon2idWorkerPolicy): Readonly<BrowserArgon2idWorkerPolicy> {
  const result = Object.freeze({ ...value })
  for (const [selected, maximum] of [
    [result.maximumPasswordBytes, 65536],
    [result.maximumIterations, 0xffffffff],
    [result.maximumMemoryKiB, 0xffffffff],
    [result.maximumParallelism, 255],
    [result.maximumMilliseconds, 30000]
  ])
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
      throw new RangeError('Invalid browser worker KDF policy')
  return result
}
const acceptedWorkers = new WeakSet<Worker>()
interface Pending {
  readonly phase: 'ready' | 'key'
  readonly length: number
  readonly resolve: (key?: Uint8Array) => void
  readonly reject: (cause: unknown) => void
  readonly began: number
  readonly deadline: number
  readonly timer: ReturnType<typeof setTimeout>
}
/** Explicit optional backend: hosts bundle the reviewed worker installer and
 * provide a NEW native Worker factory for that fixed trusted asset, never an
 * archive-supplied URL. Await preload before registering/using a ready backend.
 * Each derivation owns one one-shot worker. Successful key delivery follows
 * worker-side input erasure and native terminate() invocation. Browsers expose
 * no exit event or kernel memory quota: this is API termination, not an OS exit
 * receipt. Physical resource/hostile shared-CPU qualification remains separate.
 * Constructing/importing this class launches no worker or wallet operation. */
export class BrowserArgon2idWorkerBackend implements AsyncArgon2idBackend {
  readonly #policy: Readonly<BrowserArgon2idWorkerPolicy>
  readonly #terminate: Worker['terminate']
  readonly #post: Worker['postMessage']
  readonly #add: Worker['addEventListener']
  readonly #remove: Worker['removeEventListener']
  #worker: Worker | undefined
  #ready = false
  #closed = false
  #pending: Pending | undefined
  #preloading: Promise<void> | undefined
  #retained: Brc38StagingCleanupError | undefined
  constructor(
    private readonly createWorker: () => Worker,
    policy: BrowserArgon2idWorkerPolicy
  ) {
    this.#policy = browserArgon2idWorkerPolicy(policy)
    if (typeof Worker === 'undefined') throw new Error('Browser Argon2id backend requires native Web Workers')
    this.#terminate = Worker.prototype.terminate
    this.#post = Worker.prototype.postMessage
    this.#add = Worker.prototype.addEventListener
    this.#remove = Worker.prototype.removeEventListener
  }
  isReady(): boolean {
    return (
      !this.#closed &&
      this.#ready &&
      this.#worker !== undefined &&
      this.#pending === undefined &&
      this.#retained === undefined
    )
  }
  preload(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Browser KDF backend is closed'))
    if (this.#retained !== undefined) return Promise.reject(this.#retained)
    if (this.isReady()) return Promise.resolve()
    if (this.#preloading !== undefined) return this.#preloading
    if (this.#pending !== undefined) return Promise.reject(new Error('Browser KDF already owns a derivation'))
    const pending = Promise.resolve()
      .then(async () => {
        if (this.#closed) throw new Error('Browser KDF backend closed before worker creation')
        const worker = this.createWorker()
        if (!(worker instanceof Worker) || acceptedWorkers.has(worker))
          throw new TypeError('Browser KDF factory must return a new native Worker')
        acceptedWorkers.add(worker)
        this.#worker = worker
        // A host factory may synchronously request shutdown. The newly returned
        // original Worker is still ours to terminate; never wait for READY then.
        if (this.#closed) throw new Error('Browser KDF backend closed during worker creation')
        Reflect.apply(this.#add, worker, ['message', this.#message])
        Reflect.apply(this.#add, worker, ['error', this.#error])
        Reflect.apply(this.#add, worker, ['messageerror', this.#error])
        await this.#wait('ready', 0)
        this.#ready = true
      })
      .catch(cause => {
        this.#fail(cause)
        throw this.#retained ?? cause
      })
      .finally(() => {
        this.#preloading = undefined
      })
    this.#preloading = pending
    void pending.catch(() => {})
    return pending
  }
  async deriveKey(selected: Readonly<Argon2idOptions>): Promise<Uint8Array> {
    if (!this.isReady()) throw new Error('Browser KDF backend must be preloaded and exclusively ready')
    const iterations = selected.iterations,
      memorySize = selected.memorySize,
      parallelism = selected.parallelism,
      hashLength = selected.hashLength
    if (
      !(selected.password instanceof Uint8Array) ||
      selected.password.byteLength > this.#policy.maximumPasswordBytes ||
      !(selected.salt instanceof Uint8Array) ||
      selected.salt.byteLength < 1 ||
      selected.salt.byteLength > 255
    )
      throw new SnapshotResourceLimitError('Browser KDF input policy reached')
    for (const [value, maximum] of [
      [iterations, this.#policy.maximumIterations],
      [memorySize, this.#policy.maximumMemoryKiB],
      [parallelism, this.#policy.maximumParallelism],
      [hashLength, 1024]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new SnapshotResourceLimitError('Browser KDF parameter policy reached')
    const password = new Uint8Array(selected.password),
      salt = new Uint8Array(selected.salt),
      worker = this.#worker!
    this.#ready = false
    const pending = this.#wait('key', hashLength)
    try {
      Reflect.apply(this.#post, worker, [
        {
          type: 'derive',
          password: password.buffer,
          salt: salt.buffer,
          iterations,
          memorySize,
          parallelism,
          hashLength
        },
        [password.buffer, salt.buffer]
      ])
    } catch (cause) {
      this.#fail(cause)
    } finally {
      if (password.byteLength !== 0) password.fill(0)
      if (salt.byteLength !== 0) salt.fill(0)
    }
    const result = await pending
    if (result === undefined) throw new Error('Browser KDF did not deliver its owned key')
    return result
  }
  #wait(phase: Pending['phase'], length: number): Promise<Uint8Array | undefined> {
    const began = performance.now(),
      deadline = Date.now() + this.#policy.maximumMilliseconds
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(new SnapshotResourceLimitError('Browser KDF original deadline ended')),
        this.#policy.maximumMilliseconds
      )
      this.#pending = { phase, length, resolve, reject, began, deadline, timer }
    })
  }
  readonly #message = (event: MessageEvent<unknown>): void => {
    const pending = this.#pending,
      data = event.data
    const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
    const key = raw?.key instanceof ArrayBuffer ? new Uint8Array(raw.key) : undefined
    if (pending === undefined) {
      key?.fill(0)
      return
    }
    if (Date.now() >= pending.deadline || performance.now() - pending.began >= this.#policy.maximumMilliseconds) {
      key?.fill(0)
      this.#fail(new SnapshotResourceLimitError('Browser KDF late delivery refused'))
      return
    }
    if (pending.phase === 'ready' && raw?.type === 'ready' && raw.version === 1 && key === undefined) {
      clearTimeout(pending.timer)
      this.#pending = undefined
      pending.resolve()
      return
    }
    if (pending.phase !== 'key' || raw?.type !== 'key' || key === undefined || key.byteLength !== pending.length) {
      key?.fill(0)
      this.#fail(new Error('Browser KDF worker protocol refused'))
      return
    }
    try {
      this.#stop()
    } catch (cause) {
      key.fill(0)
      this.#fail(cause)
      return
    }
    clearTimeout(pending.timer)
    this.#pending = undefined
    pending.resolve(key)
  }
  readonly #error = (event: Event): void => {
    event.preventDefault()
    this.#fail(new Error('Browser KDF worker failed'))
  }
  #stop(): void {
    const worker = this.#worker
    if (worker === undefined) return
    Reflect.apply(this.#terminate, worker, [])
    Reflect.apply(this.#remove, worker, ['message', this.#message])
    Reflect.apply(this.#remove, worker, ['error', this.#error])
    Reflect.apply(this.#remove, worker, ['messageerror', this.#error])
    this.#worker = undefined
    this.#ready = false
  }
  #fail(cause: unknown): void {
    const pending = this.#pending
    if (pending !== undefined) clearTimeout(pending.timer)
    this.#ready = false
    try {
      this.#stop()
    } catch (error_) {
      this.#retained = new Brc38StagingCleanupError(
        [cause, error_],
        'Browser KDF retains original Worker termination',
        () => {
          return promiseFromSync(() => {
            this.#stop()
            this.#retained = undefined
          })
        }
      )
      this.#pending = undefined
      pending?.reject(this.#retained)
      return
    }
    this.#pending = undefined
    pending?.reject(cause)
  }
  async close(): Promise<void> {
    this.#closed = true
    this.#fail(new Error('Browser KDF backend closed'))
    if (this.#retained !== undefined) throw this.#retained
    await this.#preloading?.catch(() => {})
  }
  retryCleanup(): Promise<void> {
    return awaitVoidFromSync(() => this.#retained?.retryCleanup())
  }
}
