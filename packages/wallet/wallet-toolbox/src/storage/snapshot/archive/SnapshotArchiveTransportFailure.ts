/** Marker only for rejection of the native fetch promise, before response handling. */
export class SnapshotArchiveTransportFailure extends Error {
  override readonly cause: unknown
  constructor(cause: unknown) {
    super('Snapshot archive transport failed before a response was available')
    this.name = 'SnapshotArchiveTransportFailure'
    this.cause = cause
  }
}

/** A public throttle response conveys only a bounded delay, never an
 * authenticated result, copied position, permission or financial ACK. */
class SnapshotArchiveRateLimitHint extends Error {
  constructor(readonly delayMs: number) {
    super('Snapshot HTTP request was throttled; no authenticated result was received')
  }
}
export function snapshotArchiveRateLimitDelay(error: unknown): number | undefined {
  if (error instanceof SnapshotArchiveRateLimitHint) return error.delayMs
  if (!(error instanceof Error)) return undefined
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')
  return cause !== undefined && 'value' in cause && cause.value instanceof SnapshotArchiveRateLimitHint
    ? cause.value.delayMs
    : undefined
}
function retryDelay(response: Response): number {
  const value = response.headers.get('retry-after')
  if (value !== null && /^[0-9]{1,3}$/.test(value)) return Math.max(250, Math.min(60000, Number(value) * 1000))
  const rate = response.headers.get('ratelimit')
  const seconds = rate !== null && rate.length <= 1024 ? /\bt=(\d{1,3})(?=[;, ]|$)/.exec(rate)?.[1] : undefined
  return seconds === undefined ? 1000 : Math.max(250, Math.min(60000, Number(seconds) * 1000))
}
export async function waitSnapshotArchiveRateLimit(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new Error('Snapshot backoff cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Inject only into this client's dedicated AuthFetch; never wrap AuthFetch.fetch itself. */
export function snapshotArchiveFetch(implementation: typeof fetch, captureRateLimit = false): typeof fetch {
  return async (input, init) => {
    let response: Response
    try {
      response = await implementation(input, init)
    } catch (error) {
      throw new SnapshotArchiveTransportFailure(error)
    }
    if (captureRateLimit && response.status === 429) {
      const delayMs = retryDelay(response)
      await response.body?.cancel()
      throw new SnapshotArchiveRateLimitHint(delayMs)
    }
    return response
  }
}

/** The SDK transport preserves a native-fetch error as its direct own data cause. */
export function isSnapshotArchiveTransportFailure(error: unknown): boolean {
  if (error instanceof SnapshotArchiveTransportFailure) return true
  if (!(error instanceof Error)) return false
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')
  return cause !== undefined && 'value' in cause && cause.value instanceof SnapshotArchiveTransportFailure
}

/** Only immutable, idempotent requests may repeat after native connection loss. */
export async function retrySnapshotArchiveOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isSnapshotArchiveTransportFailure(error)) throw error
    return await operation()
  }
}
