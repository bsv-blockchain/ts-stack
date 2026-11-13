import { SnapshotCancelledError } from '../snapshot/SnapshotCancelledError'

/** Only queue admission creates this error, before the operation has started.
 * Keep the original signal and reason so session code cannot mistake an
 * in-flight provider failure for cancellation before ownership. */
export class StorageAccessCancelledError extends SnapshotCancelledError {
  constructor(readonly signal: AbortSignal) {
    super('Storage access was cancelled before operation admission')
    Object.defineProperty(this, 'cause', { value: signal.reason, configurable: true })
  }
}
