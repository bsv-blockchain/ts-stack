import { StorageAccessCancelledError } from './StorageAccessCancelledError'

/** Normalize only cancellation of this original queue request. Once the
 * callback starts, its durable ACK or failure remains authoritative. */
export async function commitSyncAdmission<T>(
  commit: <R>(operation: () => Promise<R>) => Promise<R>,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T | undefined> {
  let started = false
  try {
    return await commit(() => {
      started = true
      return operation()
    })
  } catch (cause) {
    if (!started && signal?.aborted === true && cause instanceof StorageAccessCancelledError && cause.signal === signal)
      return undefined
    throw cause
  }
}
