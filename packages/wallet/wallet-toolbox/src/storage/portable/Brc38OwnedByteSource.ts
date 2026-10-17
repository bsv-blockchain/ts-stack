import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38OwnedByteSourceOptions {
  readonly expiresAt: number
  readonly maximumReadMilliseconds: number
  readonly cleanupMilliseconds: number
  readonly maximumChunkBytes: number
  readonly maximumChunks: number
  readonly maximumBytes: number
  readonly signal?: AbortSignal
  /** Idempotent host cancellation/close, including pending I/O. Iterator.return
   * alone cannot interrupt a pending async-generator next. This callback must
   * refer to this actual source; it grants no storage or authentication rights. */
  readonly closeSource?: (cause?: unknown) => Promise<void>
}
function integer(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError('Invalid owned byte-source bound')
}
interface Calendar {
  readonly wall: number
  readonly began: number
  readonly milliseconds: number
}
function calendar(milliseconds: number): Calendar {
  return { wall: Date.now() + milliseconds, began: performance.now(), milliseconds }
}
function remaining(selected: Calendar): number {
  return Math.min(selected.wall - Date.now(), selected.milliseconds - (performance.now() - selected.began))
}
async function wait<T>(pending: Promise<T>, selected: Calendar, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const left = remaining(selected)
  if (left <= 0) throw new SnapshotResourceLimitError('Owned byte-source operation calendar ended')
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('Owned byte-source operation calendar ended')),
          left
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

/** One actual iterator and one outstanding read. Late bytes are detached and
 * erased, never delivered after revocation. A timeout is not physical drain:
 * failed cleanup retains the exact pending promises and an explicit retry.
 * Cleanup gets a separate finite calendar without extending source access. */
export class Brc38OwnedByteSource implements AsyncIterableIterator<Uint8Array> {
  readonly #options: Readonly<Brc38OwnedByteSourceOptions>
  readonly #began = performance.now()
  readonly #lifetime: number
  #next: (() => Promise<IteratorResult<Uint8Array>>) | undefined
  #return: (() => Promise<IteratorResult<Uint8Array>>) | undefined
  #pending: Promise<IteratorResult<Uint8Array>> | undefined
  #hostClose: Promise<void> | undefined
  #iteratorClose: Promise<void> | undefined
  #hostClosed = false
  #iteratorClosed = false
  #revoked = false
  #drained = false
  #closing = false
  #claimed = false
  #chunks = 0
  #bytes = 0
  #cause: unknown
  private constructor(options: Brc38OwnedByteSourceOptions) {
    this.#options = Object.freeze({ ...options })
    integer(this.#options.expiresAt, Number.MAX_SAFE_INTEGER)
    integer(this.#options.maximumReadMilliseconds, 30000)
    integer(this.#options.cleanupMilliseconds, 30000)
    integer(this.#options.maximumChunkBytes, 65536)
    integer(this.#options.maximumChunks, 1000000)
    integer(this.#options.maximumBytes, Number.MAX_SAFE_INTEGER)
    if (this.#options.closeSource !== undefined && typeof this.#options.closeSource !== 'function')
      throw new TypeError('Owned source close must be a function')
    this.#lifetime = this.#options.expiresAt - Date.now()
  }
  static async open(
    source: AsyncIterable<Uint8Array>,
    options: Brc38OwnedByteSourceOptions
  ): Promise<Brc38OwnedByteSource> {
    const owner = new Brc38OwnedByteSource(options)
    try {
      owner.#check()
      const select = source[Symbol.asyncIterator]
      if (typeof select !== 'function') throw new TypeError('Owned source requires an async iterator')
      const iterator = Reflect.apply(select, source, []) as AsyncIterator<Uint8Array>
      if (iterator === null || typeof iterator !== 'object') throw new TypeError('Invalid owned source iterator')
      // Capture the actual methods once; later producer property replacement
      // cannot swap the resource while an outstanding operation is retained.
      const next = iterator.next,
        finish = iterator.return
      if (typeof next !== 'function' || (finish !== undefined && typeof finish !== 'function'))
        throw new TypeError('Invalid owned source iterator methods')
      owner.#next = async () => await Reflect.apply(next, iterator, [])
      owner.#return = finish === undefined ? undefined : async () => await Reflect.apply(finish, iterator, [])
      return owner
    } catch (cause) {
      await owner.close(cause)
      throw cause
    }
  }
  #check(): void {
    this.#options.signal?.throwIfAborted()
    if (this.#revoked) throw new Error('Owned byte-source access is revoked')
    if (Date.now() >= this.#options.expiresAt || performance.now() - this.#began >= this.#lifetime)
      throw new SnapshotResourceLimitError('Owned byte-source original lifetime ended')
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    if (this.#claimed) throw new Error('Owned byte-source reader is already claimed')
    this.#claimed = true
    return this
  }
  async next(): Promise<IteratorResult<Uint8Array>> {
    try {
      this.#check()
      if (this.#pending !== undefined) throw new Error('Owned byte-source already has a pending read')
      if (this.#next === undefined) throw new Error('Owned byte-source has no actual iterator')
      const selected = calendar(
        Math.min(
          this.#options.maximumReadMilliseconds,
          this.#options.expiresAt - Date.now(),
          this.#lifetime - (performance.now() - this.#began)
        )
      )
      const next = this.#next
      const pending = Promise.resolve()
        .then(async () => {
          this.#check()
          return await next()
        })
        .then(result => {
          if (result === null || typeof result !== 'object') throw new TypeError('Invalid owned source read result')
          const done = Boolean(result.done)
          if (done) return { done: true as const, value: undefined }
          const bytes = detachBrc38PrivateChunk(result.value, this.#options.maximumChunkBytes)
          try {
            this.#check()
            if (
              ++this.#chunks > this.#options.maximumChunks ||
              bytes.byteLength > this.#options.maximumBytes - this.#bytes
            )
              throw new SnapshotResourceLimitError('Owned byte-source original extent bound reached')
            this.#bytes += bytes.byteLength
            return { done: false as const, value: bytes }
          } catch (cause) {
            bytes.fill(0)
            throw cause
          }
        })
      this.#pending = pending
      // Observe late rejection immediately. Only the owner can declare drain.
      void pending.catch(() => {})
      const result = await wait(pending, selected, this.#options.signal)
      this.#check()
      this.#pending = undefined
      if (result.done) await this.close()
      return result
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) throw cause
      await this.close(cause)
      throw cause
    }
  }
  async return(): Promise<IteratorResult<Uint8Array>> {
    await this.close()
    return { done: true, value: undefined }
  }
  async close(cause?: unknown): Promise<void> {
    if (this.#drained) return
    if (this.#closing) throw new Error('Owned byte-source cleanup is already running')
    this.#revoked = true
    this.#cause ??= cause
    this.#closing = true
    const selected = calendar(this.#options.cleanupMilliseconds)
    try {
      // Start host cancellation before awaiting next, so an actual stream
      // reader/fetch/worker can release its blocked read. Never queue repeated
      // return requests behind an undrained async-generator operation.
      if (!this.#hostClosed && this.#hostClose === undefined) {
        const close = this.#options.closeSource
        this.#hostClose = Promise.resolve().then(async () => {
          if (close !== undefined) await close(this.#cause)
        })
        void this.#hostClose.catch(() => {})
      }
      if (this.#pending !== undefined) {
        await wait(
          this.#pending.then(
            result => {
              if (!result.done) result.value.fill(0)
            },
            () => {}
          ),
          selected
        )
        this.#pending = undefined
      }
      if (!this.#iteratorClosed && this.#iteratorClose === undefined) {
        const finish = this.#return
        this.#iteratorClose = Promise.resolve().then(async () => {
          if (finish !== undefined) {
            const result = await finish()
            if (result === null || typeof result !== 'object' || !result.done)
              throw new Error('Owned source iterator did not finish during cleanup')
          }
        })
        void this.#iteratorClose.catch(() => {})
      }
      const outcomes = await wait(
        Promise.allSettled([this.#hostClose ?? Promise.resolve(), this.#iteratorClose ?? Promise.resolve()]),
        selected
      )
      const failures: unknown[] = []
      if (outcomes[0].status === 'fulfilled') this.#hostClosed = true
      else {
        failures.push(outcomes[0].reason)
        this.#hostClose = undefined
      }
      if (outcomes[1].status === 'fulfilled') this.#iteratorClosed = true
      else {
        failures.push(outcomes[1].reason)
        this.#iteratorClose = undefined
      }
      if (failures.length !== 0) throw new AggregateError(failures, 'Owned source physical close failed')
      this.#drained = true
      this.#next = undefined
      this.#return = undefined
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [this.#cause, error_],
        'Owned byte source retains actual pending I/O and physical cleanup',
        async () => await this.close(this.#cause)
      )
    } finally {
      this.#closing = false
    }
  }
}
