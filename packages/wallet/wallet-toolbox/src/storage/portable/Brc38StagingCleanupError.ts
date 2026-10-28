import { promiseFromSync } from '../../utility/promiseFromSync'

/** A failed Knex afterCreate has not transferred the actual raw connection to
 * the pool. Its setup callback must close it or retain its physical retry. */
export function closeBrc38UnpooledConnection(
  connection: { close: () => unknown },
  cause: unknown,
  fallback: string
): Error {
  const primary = cause instanceof Error ? cause : new Error(fallback)
  try {
    connection.close()
    return primary
  } catch (cleanupCause) {
    return new Brc38StagingCleanupError(
      [primary, cleanupCause],
      'Private SQLite connection setup and physical cleanup both failed',
      () =>
        promiseFromSync(() => {
          connection.close()
        })
    )
  }
}

/** Drain both the failed setup owner and its surrounding pool. A failure in
 * either cleanup must not prevent the independent physical cleanup attempt. */
export async function drainBrc38FailedConnections(
  cause: unknown,
  cleanup: () => Promise<void>,
  message: string
): Promise<void> {
  const drain = async () => {
    const results = await Promise.allSettled([
      promiseFromSync(cleanup),
      ...(cause instanceof Brc38StagingCleanupError ? [cause.retryCleanup()] : [])
    ])
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Private SQLite physical cleanup failed')
  }
  try {
    await drain()
  } catch (cleanupCause) {
    throw new Brc38StagingCleanupError([cause, cleanupCause], message, drain)
  }
}

/** One initial teardown attempt for an operation or generator scope. Failure
 * paths call close before propagating their cause; finally calls it for normal
 * completion and iterator return. A rejected initial attempt is never repeated
 * by finally: physical retries belong to the concrete cleanup error owner. */
export class Brc38CleanupScope {
  #completion?: Promise<void>
  constructor(private readonly cleanup: () => Promise<void>) {}
  close(): Promise<void> {
    if (this.#completion === undefined) {
      let complete!: () => void, fail!: (cause: unknown) => void
      // Publish the shared completion before invoking cleanup, but revoke the
      // actor synchronously through its first await, just as an inline finally.
      this.#completion = new Promise<void>((resolve, reject) => {
        complete = resolve
        fail = reject
      })
      void promiseFromSync(() => this.cleanup()).then(complete, fail)
    }
    return this.#completion
  }
}

/** A failed physical teardown retains a concrete retry owner, never a guessed
 * PID or an abandoned inaccessible lock. The initial and teardown causes stay
 * attached; callers must await retryCleanup before accepting physical drain. */
export class Brc38StagingCleanupError extends AggregateError {
  #busy = false
  #done = false
  constructor(
    causes: readonly unknown[],
    message: string,
    private readonly cleanup: () => Promise<void>
  ) {
    super(causes, message, { cause: causes[0] })
  }
  async retryCleanup(): Promise<void> {
    if (this.#done) return
    if (this.#busy) throw new Error('Private BRC-38 physical cleanup is already owned')
    this.#busy = true
    try {
      await this.cleanup()
      this.#done = true
    } finally {
      this.#busy = false
    }
  }
}
