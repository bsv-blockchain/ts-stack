import { toHex } from '@bsv/sdk/primitives/utils'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import type { KnexSnapshotArchiveStore } from '../archive/KnexSnapshotArchiveStore'
import type { SnapshotArchiveWriter } from '../archive/SnapshotArchive'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalPosition } from './SnapshotJournalTypes'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalProvider'
import {
  parseSnapshotJournalArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalArchiveManifest
} from './SnapshotJournalArchiveBinding'
import {
  encodeSnapshotJournalArchiveFrame,
  decodeSnapshotJournalArchivePacket,
  encodeSnapshotJournalArchiveIdentities,
  encodeSnapshotJournalArchiveIdentityGroups,
  type SnapshotJournalArchiveIdentityGroup,
  snapshotJournalArchiveEncoding
} from './SnapshotJournalArchivePacket'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { parseSnapshotJournalArchivePosition, type SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'
export type { SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'

export type SnapshotJournalArchiveCaptureStore = Pick<
  KnexSnapshotArchiveStore,
  'beginJournal' | 'appendJournal' | 'sealJournal'
> & { close: (identityKey: string, archiveId: string, error?: unknown) => Promise<void> }

/** Capture actual immutable DATA while retaining the genuine pinned source and
 * its archive guard. No SQL actor/fence is reconstructed from the output. Every
 * identity prefix is bounded and charged; ready follows physical source close. */
export async function captureSnapshotJournalArchiveSource(
  source: SnapshotJournalReconciliationSource,
  store: SnapshotJournalArchiveCaptureStore,
  position?: SnapshotJournalArchivePosition,
  options: { lifetimeMs?: number; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<SnapshotJournalArchiveManifest> {
  let writer: SnapshotArchiveWriter | undefined,
    failure: { error: unknown } | undefined,
    manifest: SnapshotJournalArchiveManifest | undefined
  const active = () => {
    if (options.signal?.aborted) throw new SnapshotCancelledError('Journal archive capture cancelled')
  }
  try {
    const previous = parseSnapshotJournalArchivePosition(position === undefined ? null : position)
    active()
    await source.verifyLive()
    if (
      previous?.binding === source.receipt.binding &&
      compareSnapshotJournalRevisions(previous.highWater, source.receipt.highWater) > 0
    )
      throw new TypeError('Journal archive position exceeds the actual source high-water')
    const incremental =
        previous !== undefined &&
        previous.binding === source.receipt.binding &&
        compareSnapshotJournalRevisions(previous.highWater, source.receipt.floor) >= 0,
      low = incremental ? previous.highWater : snapshotJournalRevision('0'),
      contentRevision = await source.readContentRevision?.(),
      binding = parseSnapshotJournalArchiveBinding({
        version: 3,
        encoding: snapshotJournalArchiveEncoding,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        sourceSchema: source.sourceSchema,
        user: source.user,
        journal: {
          source: source.receiptBinding,
          receipt: source.receipt,
          low,
          bootstrap: !incremental,
          primary: source.primary,
          ...(contentRevision === undefined ? {} : { contentRevision })
        }
      })
    // The immutable source receipt is never extended to fit archive admission.
    writer = await store.beginJournal(binding, options)
    if (!incremental) await source.validateClosure()
    let sequence = 0
    const append = async (
      table: (typeof snapshotJournalArchiveStreams)[number]['table'],
      bytes: Uint8Array,
      rows: number,
      done: boolean
    ) => {
      active()
      if (sequence >= snapshotArchiveLimits.pages)
        throw new SnapshotResourceLimitError('Journal archive page bound reached')
      await store.appendJournal(writer!, { sequence, table, rows, done, bytes })
      sequence++
    }
    for (const stream of snapshotJournalArchiveStreams) {
      const context = { stream: stream.stream, tableId: stream.tableId }
      let after: SnapshotJournalPosition | undefined,
        complete = false
      while (!complete) {
        active()
        const request = {
          ...context,
          low,
          ...(incremental ? {} : { bootstrap: true as const }),
          after,
          maximumRows: 8,
          maximumBytes: 262144
        }
        let captured: Awaited<ReturnType<SnapshotJournalReconciliationSource['readDeltaPage']>>
        if (source.readArchiveDeltaPage === undefined) {
          captured = await source.readDeltaPage(request, async (digest, changeIndex, identities) => {
            await append(
              stream.table,
              encodeSnapshotJournalArchiveIdentities(
                context,
                digest,
                changeIndex,
                identities,
                binding.journal.receipt.highWater
              ),
              0,
              false
            )
          })
        } else {
          let groups: SnapshotJournalArchiveIdentityGroup[] = [],
            encoded: Uint8Array | undefined,
            groupDigest: string | undefined
          const flush = (): Promise<void> => {
            if (encoded === undefined) throw new TypeError('No actual journal identity prefix to flush')
            const bytes = encoded
            return append(stream.table, bytes, 0, false).then(() => {
              groups = []
              encoded = undefined
            })
          }
          captured = await source.readArchiveDeltaPage(request, (digest, changeIndex, identities) => {
            if (groupDigest !== undefined && groupDigest !== digest)
              throw new TypeError('Journal frame digest changed within prefixes')
            groupDigest = digest
            const group: SnapshotJournalArchiveIdentityGroup = { changeIndex, identities }
            try {
              const candidate = [...groups, group],
                next = encodeSnapshotJournalArchiveIdentityGroups(
                  context,
                  digest,
                  candidate,
                  binding.journal.receipt.highWater
                )
              // Own every bounded map/cell before returning to the producer.
              const owned = decodeSnapshotJournalArchivePacket(next, context, binding.journal.receipt.highWater)
              if (owned.kind !== 'identity-groups') throw new TypeError('Expected bounded journal identity groups')
              groups = [...owned.groups]
              encoded = next
            } catch (error) {
              if (!(error instanceof SnapshotResourceLimitError) || groups.length === 0) throw error
              return flush().then(() => {
                const next = encodeSnapshotJournalArchiveIdentityGroups(
                    context,
                    digest,
                    [group],
                    binding.journal.receipt.highWater
                  ),
                  owned = decodeSnapshotJournalArchivePacket(next, context, binding.journal.receipt.highWater)
                if (owned.kind !== 'identity-groups') throw new TypeError('Expected bounded journal identity groups')
                groups = [...owned.groups]
                encoded = next
              })
            }
          })
          if (encoded !== undefined) await flush()
        }
        active()
        const frame = encodeSnapshotJournalDeltaFrame(captured.page, context)
        if (toHex(sha256(frame)) !== captured.frameDigest) throw new TypeError('Captured journal frame digest changed')
        await append(
          stream.table,
          encodeSnapshotJournalArchiveFrame(context, captured.page),
          captured.page.changes.length,
          captured.page.complete
        )
        if (
          !captured.page.complete &&
          (captured.page.after === undefined || JSON.stringify(captured.page.after) === JSON.stringify(after))
        )
          throw new TypeError('Journal archive source did not advance its keyset')
        after = captured.page.after
        complete = captured.page.complete
      }
    }
    await source.verifyLive()
  } catch (error) {
    failure = { error }
  }
  // Cleanup failures retain the reservation. Never infer physical closure from
  // a rejected read, cancellation request or the existence of staged DATA.
  try {
    await closeSnapshotJournalSource(source, options.signal)
  } catch (error) {
    if (failure !== undefined && failure.error !== error)
      throw new AggregateError([failure.error, error], 'Journal archive capture and physical cleanup failed', {
        cause: failure.error
      })
    throw error
  }
  if (failure === undefined) {
    try {
      active()
      if (writer === undefined) throw new TypeError('Journal archive writer was not admitted')
      manifest = await store.sealJournal(writer)
      active()
      return manifest
    } catch (error) {
      failure = { error }
    }
  }
  if (writer !== undefined) {
    try {
      await store.close(source.user.identityKey, writer.archiveId, failure.error)
    } catch (error) {
      throw new AggregateError([failure.error, error], 'Journal archive failure and staged cleanup failed', {
        cause: failure.error
      })
    }
  }
  throw failure.error
}
