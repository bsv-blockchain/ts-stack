import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

/** Actual preparation I/O ownership only. It conveys no authentication,
 * semantic, backend/schema or effect authority. The original deadline is
 * immutable; a late result cannot reopen the scope. Non-cancellable host work
 * is retained through bounded drainage/retry rather than called cancelled. */
export class Brc38OwnedPreparation {
  readonly #deadline: number
  #closed = false
  #active?: Promise<unknown>
  #cleanup?: Brc38StagingCleanupError
  #stop?: () => void
  constructor(
    private readonly expiresAt: number,
    private readonly operationMilliseconds = 30000,
    private readonly cleanupMilliseconds = 30000,
    private readonly signal?: AbortSignal,
    originalDeadline?: number
  ) {
    if (
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(operationMilliseconds) ||
      operationMilliseconds < 1 ||
      operationMilliseconds > 30000 ||
      !Number.isSafeInteger(cleanupMilliseconds) ||
      cleanupMilliseconds < 1 ||
      cleanupMilliseconds > 30000 ||
      (originalDeadline !== undefined && !Number.isFinite(originalDeadline))
    )
      throw new RangeError('Invalid original private preparation bounds')
    this.#deadline = Math.min(originalDeadline ?? Infinity, performance.now() + Math.max(0, expiresAt - Date.now()))
  }
  #check(): void {
    this.signal?.throwIfAborted()
    if (this.#closed || Date.now() >= this.expiresAt || performance.now() >= this.#deadline)
      throw new SnapshotResourceLimitError('Private preparation original admission is closed or expired')
  }
  async #drain(job: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        job.then(
          () => undefined,
          () => undefined
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Private preparation physical work still awaits drainage')),
            this.cleanupMilliseconds
          )
        })
      ])
      if (this.#active === job) this.#active = undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#check()
    if (this.#active !== undefined) throw new Error('Private preparation requires one serial awaited operation')
    let rejectStop!: (cause: unknown) => void, timer: ReturnType<typeof setTimeout> | undefined
    const stop = new Promise<never>((_resolve, reject) => {
        rejectStop = reject
      }),
      abort = () =>
        rejectStop(
          this.signal?.reason ?? new SnapshotResourceLimitError('Private preparation original operation stopped')
        ),
      job = Promise.resolve().then(() => {
        this.#check()
        return work()
      })
    this.#active = job
    this.#stop = abort
    void job.catch(() => undefined)
    this.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(
      abort,
      Math.max(1, Math.min(this.operationMilliseconds, this.expiresAt - Date.now(), this.#deadline - performance.now()))
    )
    try {
      const result = await Promise.race([job, stop])
      this.#check()
      this.#active = undefined
      return result
    } catch (cause) {
      this.#closed = true
      try {
        await this.#drain(job)
      } catch (error_) {
        const cleanup = () =>
          mapAwaitFromSync(
            () => this.#drain(job),
            () => {
              this.#cleanup = undefined
            }
          )
        this.#cleanup = new Brc38StagingCleanupError(
          [cause, error_],
          'Private preparation retains actual non-cancellable work until drainage',
          cleanup
        )
        throw this.#cleanup
      }
      throw cause
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.signal?.removeEventListener('abort', abort)
      if (this.#stop === abort) this.#stop = undefined
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    this.#stop?.()
    if (this.#cleanup !== undefined) await this.#cleanup.retryCleanup()
    else if (this.#active !== undefined) await this.#drain(this.#active)
  }
}
