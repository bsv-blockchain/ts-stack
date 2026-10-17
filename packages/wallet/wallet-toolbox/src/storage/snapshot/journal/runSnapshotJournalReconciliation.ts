import type { SnapshotJournalReconciliationSource } from './SnapshotJournalProvider'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import type { SnapshotJournalProgress } from './SnapshotJournalTypes'

export interface SnapshotJournalReconciliationProgress {
  state: 'committed' | 'cancelRequested' | 'stopped' | 'complete'
  checkpoint: SnapshotJournalDestinationCheckpoint
  progress: SnapshotJournalProgress
}
export interface SnapshotJournalReconciliationOptions {
  signal?: AbortSignal
  onProgress?: (value: SnapshotJournalReconciliationProgress) => void
}
export interface SnapshotJournalReconciliationDestination {
  status: () => Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; progress: SnapshotJournalProgress }>
  intake: (checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<unknown>
  promote: (checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<unknown>
}

/** One finite retained source window. Actual writer admission belongs to the
 * destination's authenticated manager queue. Source reads/proof preparation and
 * progress observers run outside that queue; each destination operation settles
 * its physical writer before yielding. Restart reads destination-owned progress.
 * A complete window does not activate a primary or claim release qualification.
 */
export async function* runSnapshotJournalReconciliation(
  source: Pick<SnapshotJournalReconciliationSource, 'close' | 'closed'>,
  openDestination: () => Promise<SnapshotJournalReconciliationDestination>,
  options: SnapshotJournalReconciliationOptions = {}
): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
  let closing: Promise<void> | undefined
  const close = () => (closing ??= closeSnapshotJournalSource(source, options.signal))
  const own = (value: SnapshotJournalReconciliationProgress): SnapshotJournalReconciliationProgress => ({
    state: value.state,
    checkpoint: {
      ...value.checkpoint,
      ...(value.checkpoint.after === undefined ? {} : { after: { ...value.checkpoint.after } })
    },
    progress: { ...value.progress }
  })
  const emit = (value: SnapshotJournalReconciliationProgress) => {
    options.onProgress?.(own(value))
    return own(value)
  }
  try {
    const destination = await openDestination()
    let status = await destination.status()
    while (status.checkpoint.phase !== 'acknowledged') {
      if (options.signal?.aborted) {
        yield emit({ state: 'cancelRequested', ...status })
        await close()
        const stopped = emit({ state: 'stopped', ...status })
        yield stopped
        return stopped
      }
      try {
        if (status.checkpoint.phase === 'intake') await destination.intake(status.checkpoint)
        else await destination.promote(status.checkpoint)
      } catch (error) {
        // An aborted caller or lost reply cannot decide whether SQL committed.
        // Observe the actual durable checkpoint/counters with no new semantic
        // admission, then stop only after source physical ownership is drained.
        const recovered = await destination.status()
        const committed =
          recovered.checkpoint.sessionId === status.checkpoint.sessionId &&
          recovered.checkpoint.binding === status.checkpoint.binding &&
          recovered.progress.commits > status.progress.commits
        status = recovered
        const cancellation =
          options.signal?.aborted === true &&
          (error instanceof SnapshotCancelledError || error === options.signal.reason)
        if (!options.signal?.aborted || (!cancellation && !committed)) {
          if (!committed) throw error
          yield emit({ state: 'committed', ...status })
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          continue
        }
        yield emit({ state: 'cancelRequested', ...status })
        await close()
        const stopped = emit({ state: 'stopped', ...status })
        yield stopped
        return stopped
      }
      status = await destination.status()
      yield emit({ state: 'committed', ...status })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await close()
    const complete = emit({ state: 'complete', ...status })
    yield complete
    return complete
  } finally {
    await close()
  }
}
