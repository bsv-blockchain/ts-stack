/** Internal I/O scope, never an authentication or destination authority token.
 * One bounded private read is physically drained before its actual owner can
 * release. An escaped facade cannot enqueue work after its callback settles. */
export class Brc38OwnedImportReads {
  #closed = false
  #pending: Promise<unknown> | undefined
  #failed = false
  #failure: unknown
  run<T>(read: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#pending !== undefined || this.#failed) {
      const refusal = Promise.reject<T>(new Error('Owned private import read is unavailable or already pending'))
      void refusal.catch(() => undefined)
      return refusal
    }
    const job = Promise.resolve().then(read)
    this.#pending = job
    void job.then(
      () => {
        if (this.#pending === job) this.#pending = undefined
      },
      cause => {
        this.#failed = true
        this.#failure = cause
        if (this.#pending === job) this.#pending = undefined
      }
    )
    return job
  }
  async finish(): Promise<void> {
    this.#closed = true
    await this.#pending?.then(
      () => undefined,
      () => undefined
    )
    if (this.#failed) throw this.#failure
  }
  async retain<T>(work: () => Promise<T>): Promise<T> {
    let failed = false,
      cause: unknown,
      result: T | undefined
    try {
      result = await work()
    } catch (error_) {
      failed = true
      cause = error_
    }
    try {
      await this.finish()
    } catch (error_) {
      if (failed && error_ !== cause)
        throw new AggregateError([cause, error_], 'Private import callback and owned read both failed')
      throw error_
    }
    if (failed) throw cause
    return result as T
  }
}
