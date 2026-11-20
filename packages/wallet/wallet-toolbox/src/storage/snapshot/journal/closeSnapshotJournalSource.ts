import { SnapshotCancelledError } from '../SnapshotCancelledError'
import type { SnapshotJournalSource } from './SnapshotJournalProvider'

/** A logical cancellation is not physical cleanup failure. Always observe both
 * close and the owned lifetime, including when close itself rejects. No caller
 * may return stopped until the physical lifetime has actually settled. */
export async function closeSnapshotJournalSource(
  source: Pick<SnapshotJournalSource, 'close' | 'closed'>,
  signal?: AbortSignal
): Promise<void> {
  const failures: unknown[] = []
  const observe = (error: unknown): void => {
    if (signal?.aborted && (error instanceof SnapshotCancelledError || error === signal.reason)) return
    if (!failures.includes(error)) failures.push(error)
  }
  try {
    await source.close()
  } catch (error) {
    observe(error)
  }
  try {
    await source.closed
  } catch (error) {
    observe(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Journal source close and physical cleanup failed', { cause: failures[0] })
}
