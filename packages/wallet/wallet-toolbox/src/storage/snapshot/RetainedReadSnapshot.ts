import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Local database view only. This is not a remote export or authorization token. */
export interface RetainedReadSnapshotOptions {
  /** Total lifetime, including connection acquisition. Defaults to five minutes; at most one hour. */
  lifetimeMs?: number
  /** Stops admission and discards late results; physical database work must drain before release. */
  signal?: AbortSignal
}

export interface RetainedReadSnapshot {
  /** Informational wall-clock expiry. Admission also enforces a monotonic lifetime. */
  readonly expiresAt: number
  readonly isOpen: boolean
  /** Settles only after the provider has finished its transaction and connection cleanup. */
  readonly closed: Promise<void>
  /**
   * One database read at a time. Await every query before returning; the token
   * is valid only inside the callback. Do not
   * write, perform peer/file I/O, or await close() from inside this callback.
   * Nested/concurrent reads reject rather than creating an unbounded queue.
   */
  read: <T>(read: (trx: TrxToken) => Promise<T>) => Promise<T>
  /** Stop admission, discard late results, and await physical transaction cleanup. Idempotent. */
  close: () => Promise<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Provider-owned lifecycle; retain the admission slot until `closed` settles, even if opening is cancelled. */
export interface RetainedReadSnapshotLifetime {
  opened: Promise<RetainedReadSnapshot>
  closed: Promise<void>
  close: () => Promise<void>
}

export function retainReadSnapshot(
  run: (read: (trx: TrxToken) => Promise<void>) => Promise<void>,
  establishView: (trx: TrxToken) => Promise<void>,
  options: RetainedReadSnapshotOptions = {}
): RetainedReadSnapshotLifetime {
  const lifetimeMs = options.lifetimeMs ?? 300_000
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3_600_000) {
    throw new WERR_INVALID_PARAMETER('lifetimeMs', 'an integer from 1 to 3600000')
  }
  const { signal } = options
  const expiresAt = Date.now() + lifetimeMs
  const startedAt = performance.now()
  const opened = deferred<RetainedReadSnapshot>()
  const stopped = deferred<void>()
  const closed = deferred<void>()
  let token: TrxToken | undefined
  let stopReason: WERR_INVALID_OPERATION | undefined
  let readFailure: { error: unknown } | undefined
  let inFlight: Promise<void> | undefined
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // Automatic expiry/failure cleanup remains observed even if a caller only
  // awaits read(). The original promise still reports cleanup failure to close().
  void closed.promise.catch(() => undefined)

  const stop = (reason: WERR_INVALID_OPERATION): void => {
    if (stopReason !== undefined) return
    stopReason = reason
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    opened.reject(reason)
    stopped.resolve()
  }
  const abort = (): void => stop(new WERR_INVALID_OPERATION('Retained read snapshot was cancelled'))
  const checkDeadline = (): void => {
    if (Date.now() >= expiresAt || performance.now() - startedAt >= lifetimeMs) {
      stop(new WERR_INVALID_OPERATION('Retained read snapshot expired'))
    }
  }
  const assertOpen = (): void => {
    checkDeadline()
    if (stopReason !== undefined) throw stopReason
  }
  const close = async (): Promise<void> => {
    stop(new WERR_INVALID_OPERATION('Retained read snapshot is closed'))
    await closed.promise
  }
  const snapshot: RetainedReadSnapshot = {
    expiresAt,
    get isOpen() {
      checkDeadline()
      // The handle is delivered only after the provider has established its view.
      return stopReason === undefined
    },
    closed: closed.promise,
    close,
    async read<T>(read: (trx: TrxToken) => Promise<T>): Promise<T> {
      assertOpen()
      if (busy) throw new WERR_INVALID_OPERATION('Retained read snapshot already has a read in flight')
      if (typeof read !== 'function') throw new WERR_INVALID_PARAMETER('read', 'a database read callback')
      busy = true
      // Invoke immediately after admission. A synchronous throw is a failed
      // physical read too; neither failure nor cancellation frees the slot early.
      const pending = (async () => await read(token as TrxToken))()
      inFlight = pending.then(
        () => undefined,
        error => {
          readFailure = { error }
          stop(new WERR_INVALID_OPERATION('Retained read snapshot read failed'))
        }
      )
      try {
        const result = await pending
        assertOpen()
        return result
      } finally {
        busy = false
        inFlight = undefined
      }
    }
  }

  const finish = async (): Promise<void> => {
    try {
      if (stopReason === undefined) {
        await run(async trx => {
          if (stopReason !== undefined) return
          token = trx
          await establishView(trx)
          checkDeadline()
          if (stopReason !== undefined) return
          opened.resolve(snapshot)
          await stopped.promise
          await inFlight
          if (readFailure !== undefined) throw readFailure.error
        })
      }
      closed.resolve()
    } catch (error) {
      opened.reject(error)
      closed.reject(error)
    } finally {
      stop(new WERR_INVALID_OPERATION('Retained read snapshot is closed'))
      token = undefined
    }
  }

  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  if (stopReason === undefined) {
    timer = setTimeout(() => stop(new WERR_INVALID_OPERATION('Retained read snapshot expired')), lifetimeMs)
  }
  // Let the provider reserve its capacity slot before any acquisition hook can re-enter.
  void Promise.resolve().then(finish)
  return { opened: opened.promise, closed: closed.promise, close }
}
