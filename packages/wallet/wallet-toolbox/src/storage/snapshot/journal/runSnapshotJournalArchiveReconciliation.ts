import { awaitFromSync, awaitVoidFromSync } from '../../../utility/promiseFromSync'
import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import { assertRemoteSnapshotJournalFieldArchive } from './openRemoteSnapshotJournalFieldArchive'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { RemoteSnapshotJournalArchive } from './openRemoteSnapshotJournalArchive'
import type { SnapshotJournalDestinationCheckpoint, SnapshotJournalProgress } from './SnapshotJournalTypes'
import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import {
  encodeSnapshotJournalArchiveIdentities,
  encodeSnapshotJournalArchiveFrame
} from './SnapshotJournalArchivePacket'
import {
  runSnapshotJournalReconciliation,
  type SnapshotJournalReconciliationOptions,
  type SnapshotJournalReconciliationProgress
} from './runSnapshotJournalReconciliation'

/** Concrete local or authenticated remote target. Only status reports its actual
 * durable ACK; sender progress and prefix uploads never advance this position. */
export interface SnapshotJournalDataDestination {
  status: () => Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; progress: SnapshotJournalProgress }>
  stagePacket: (checkpoint: SnapshotJournalDestinationCheckpoint, bytes: Uint8Array) => Promise<unknown>
  promote: (checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<unknown>
}

/** Streams one verified immutable source into a separately admitted destination.
 * No SQL writer or manager queue spans artifact I/O, retries or progress callbacks.
 * The existing coordinator recovers lost ACKs from target status and drains the
 * real source owner on cancellation/error/completion. No primary is selected. */
export async function* runSnapshotJournalArchiveReconciliation(
  archive: RemoteSnapshotJournalArchive,
  openDestination: () => Promise<SnapshotJournalDataDestination>,
  options: SnapshotJournalReconciliationOptions = {}
): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
  return yield* runSnapshotJournalReconciliation(
    archive,
    async () => {
      const destination = await openDestination(),
        manifest = archive.manifest
      return {
        status: () => destination.status(),
        intake: async (expected: SnapshotJournalDestinationCheckpoint) => {
          const stream = snapshotJournalArchiveStreams[expected.streamIndex]
          if (expected.phase !== 'intake' || stream === undefined || expected.sequence >= archive.frameCount)
            throw new WERR_INVALID_OPERATION('Journal archive differs from the actual destination intake ordinal')
          const context = { stream: stream.stream, tableId: stream.tableId }
          const frame = await archive.readFrame(expected.sequence, (digest, index, identities) =>
            awaitVoidFromSync(() =>
              destination.stagePacket(
                expected,
                encodeSnapshotJournalArchiveIdentities(
                  context,
                  digest,
                  index,
                  identities,
                  manifest.binding.journal.receipt.highWater
                )
              )
            )
          )
          if (frame.stream !== stream.stream || frame.tableId !== stream.tableId)
            throw new WERR_INVALID_OPERATION('Journal archive frame differs from destination stream')
          return await destination.stagePacket(expected, encodeSnapshotJournalArchiveFrame(context, frame.page))
        },
        promote: expected => destination.promote(expected)
      }
    },
    options
  )
}

/** Actual issued field archives remain local capabilities. No packet DATA is
 * interpreted as an archive owner or as permission to perform financial work. */
export interface SnapshotJournalFieldDestination {
  /** Close the actual target upload, after every in-flight packet settles. */
  close?: () => Promise<void>
  status: SnapshotJournalDataDestination['status']
  stageArchiveFrame: (
    checkpoint: SnapshotJournalDestinationCheckpoint,
    archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive
  ) => Promise<unknown>
  promote: (
    checkpoint: SnapshotJournalDestinationCheckpoint,
    archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive
  ) => Promise<unknown>
}
export async function* runSnapshotJournalFieldArchiveReconciliation(
  archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive,
  openDestination: () => Promise<SnapshotJournalFieldDestination>,
  options: SnapshotJournalReconciliationOptions = {}
): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
  assertRemoteSnapshotJournalFieldArchive(archive)
  let destination: SnapshotJournalFieldDestination | undefined,
    closing: Promise<void> | undefined,
    resolveClosed!: () => void,
    rejectClosed!: (cause: unknown) => void
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  void closed.catch(() => undefined)
  const lifetime = {
    closed,
    close: () => {
      if (closing !== undefined) return closing
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => awaitFromSync(() => destination?.close?.())),
            closeSnapshotJournalSource(archive, options.signal)
          ]),
          failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1)
          throw new AggregateError(failures, 'Field target upload and source artifact cleanup failed', {
            cause: failures[0]
          })
      })
      void closing.then(resolveClosed, rejectClosed)
      return closing
    }
  }
  return yield* runSnapshotJournalReconciliation(
    lifetime,
    async () => {
      destination = await openDestination()
      const actual = destination
      return {
        status: () => actual.status(),
        intake: expected => actual.stageArchiveFrame(expected, archive),
        promote: expected => actual.promote(expected, archive)
      }
    },
    options
  )
}
