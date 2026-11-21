import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

export interface SnapshotJournalMaintenanceOptions {
  /** Total admission/result lifetime; physical native cleanup must still drain. */
  lifetimeMs?: number
  signal?: AbortSignal
}
export interface SnapshotJournalMaintenanceTask<T> {
  result: Promise<T>
  closed: Promise<void>
  close: () => Promise<void>
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Private owner lifecycle. The run callback must await every native operation
 * and all physical cleanup. Rejecting result never releases the provider slot;
 * only closed permits admission. A cancellation after commit discards the late
 * result without claiming rollback; floor/page retry uses database state.
 */
export function runSnapshotJournalMaintenanceTask<T>(
  run: (assertActive: () => void) => Promise<T>,
  options: SnapshotJournalMaintenanceOptions = {}
): SnapshotJournalMaintenanceTask<T> {
  const lifetimeMs = options.lifetimeMs ?? 5000,
    signal = options.signal
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 30000)
    throw new WERR_INVALID_PARAMETER('lifetimeMs', 'an integer from 1 to 30000')
  const result = deferred<T>(),
    closed = deferred<void>()
  const expiresAt = Date.now() + lifetimeMs,
    started = performance.now()
  let stopReason: WERR_INVALID_OPERATION | undefined,
    finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  void result.promise.catch(() => undefined)
  void closed.promise.catch(() => undefined)
  const detach = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
  const stop = (reason: WERR_INVALID_OPERATION) => {
    if (finished || stopReason !== undefined) return
    stopReason = reason
    detach()
    result.reject(reason)
  }
  const abort = () => stop(new SnapshotCancelledError('Snapshot journal maintenance was cancelled'))
  const assertActive = () => {
    if (Date.now() >= expiresAt || performance.now() - started >= lifetimeMs)
      stop(new SnapshotResourceLimitError('Snapshot journal maintenance expired'))
    if (stopReason !== undefined) throw stopReason
  }
  const finish = async () => {
    try {
      assertActive()
      const value = await run(assertActive)
      assertActive()
      closed.resolve()
      result.resolve(value)
    } catch (error) {
      if (stopReason !== undefined && error === stopReason) closed.resolve()
      else closed.reject(error)
      result.reject(error)
    } finally {
      finished = true
      detach()
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  if (stopReason === undefined)
    timer = setTimeout(() => stop(new SnapshotResourceLimitError('Snapshot journal maintenance expired')), lifetimeMs)
  void Promise.resolve().then(finish)
  return {
    result: result.promise,
    closed: closed.promise,
    async close() {
      stop(new WERR_INVALID_OPERATION('Snapshot journal maintenance is closed'))
      await closed.promise
    }
  }
}
