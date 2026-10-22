import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { retrySnapshotArchiveOperation } from './SnapshotArchiveTransportFailure'

/** Fencing has succeeded, but the source has not acknowledged cleanup. */
export class SnapshotArchiveCleanupPendingError extends WERR_INVALID_OPERATION {
  constructor() {
    super('Snapshot archive source cleanup is pending')
  }
}

export interface SnapshotArchiveCleanupPending {
  version: 1
  outcome: 'cleanup-pending'
  requestId: string
}

/** The existing true acknowledgement remains the only successful completion. */
export function validateSnapshotArchiveCancellation(input: unknown, requestId: string): void {
  if (input === true) return
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 3)
    throw new TypeError('Invalid snapshot archive cancellation receipt')
  const expected = { version: 1, outcome: 'cleanup-pending', requestId }
  for (const [key, value] of Object.entries(expected)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (field === undefined || !('value' in field) || !field.enumerable || field.value !== value)
      throw new TypeError('Invalid snapshot archive cancellation receipt')
  }
  throw new SnapshotArchiveCleanupPendingError()
}

/** Separate fixed cleanup allowance; neither the source lease nor request identity is renewed. */
export const snapshotArchiveCleanupLimits = Object.freeze({ lifetimeMs: 30000, attempts: 32, delayMs: 1000 })

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
    // The private signal was checked immediately before this synchronous setup.
  })
}

/** Bound polling and abort outstanding I/O, but await its settlement before releasing the caller. */
export async function drainSnapshotArchiveRequest(cancel: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const startedAt = performance.now()
  const expiresAt = Date.now() + snapshotArchiveCleanupLimits.lifetimeMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), snapshotArchiveCleanupLimits.lifetimeMs)
  const remaining = (): number =>
    Math.min(expiresAt - Date.now(), snapshotArchiveCleanupLimits.lifetimeMs - (performance.now() - startedAt))
  const assertTime = (): void => {
    if (controller.signal.aborted || remaining() <= 0) throw new SnapshotArchiveCleanupPendingError()
  }
  let complete = false
  let delay = 100
  function* attempts() {
    for (let attempt = 0; attempt < snapshotArchiveCleanupLimits.attempts && !complete; attempt++) yield attempt
  }
  try {
    await runInSeries(attempts(), async () => {
      assertTime()
      try {
        await retrySnapshotArchiveOperation(async () => {
          assertTime()
          await cancel(controller.signal)
        })
        complete = true
      } catch (error) {
        if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
        assertTime()
        await wait(Math.min(delay, remaining()), controller.signal)
        delay = Math.min(delay * 2, snapshotArchiveCleanupLimits.delayMs)
      }
    })
    if (!complete) throw new SnapshotArchiveCleanupPendingError()
  } finally {
    clearTimeout(timer)
  }
}
