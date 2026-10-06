/** Marker only for rejection of the native fetch promise, before response handling. */
export class SnapshotArchiveTransportFailure extends Error {
  override readonly cause: unknown
  constructor(cause: unknown) {
    super('Snapshot archive transport failed before a response was available')
    this.name = 'SnapshotArchiveTransportFailure'
    this.cause = cause
  }
}

/** Inject only into this client's dedicated AuthFetch; never wrap AuthFetch.fetch itself. */
export function snapshotArchiveFetch(implementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await implementation(input, init)
    } catch (error) {
      throw new SnapshotArchiveTransportFailure(error)
    }
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
