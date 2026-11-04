import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import type { WalletReadSnapshotOptions } from '../WalletReadSnapshot'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { OwnedRemoteSnapshotLease } from '../archive/RemoteSnapshotLease'
import { RemoteSnapshotOpeningCleanupError } from '../archive/openRemoteSnapshot'
import {
  parseSnapshotJournalArchiveReaderRequest,
  type SnapshotJournalArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import {
  parseSnapshotJournalArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalArchiveManifest
} from './SnapshotJournalArchiveBinding'
import { decodeSnapshotJournalArchivePacket } from './SnapshotJournalArchivePacket'
import type { SnapshotJournalArchiveTransport } from './SnapshotJournalArchiveTransport'
import { parseSnapshotJournalArchivePosition, type SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'
import type { SnapshotJournalDeltaPage, SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'

/** An actual opened HTTP artifact, deliberately distinct from a live SQL source.
 * Frame ordinals match destination intake ordinals; identity prefixes do not
 * advance that checkpoint and may be replayed after an uncertain response. */
export interface RemoteSnapshotJournalArchive {
  readonly manifest: SnapshotJournalArchiveManifest
  readonly frameCount: number
  readonly expiresAt: number
  readonly isOpen: boolean
  readonly closed: Promise<void>
  close: () => Promise<void>
  readFrame: (
    ordinal: number,
    captureIdentities: (
      frameDigest: string,
      changeIndex: number,
      identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
    ) => Promise<void>
  ) => Promise<{ page: SnapshotJournalDeltaPage; frameDigest: string; stream: 'scope' | 'physical'; tableId: number }>
}

export async function openRemoteSnapshotJournalArchive(
  transport: SnapshotJournalArchiveTransport,
  inputPosition?: SnapshotJournalArchivePosition,
  options: WalletReadSnapshotOptions = {}
): Promise<RemoteSnapshotJournalArchive | undefined> {
  const position = parseSnapshotJournalArchivePosition(inputPosition ?? null),
    lease = new OwnedRemoteSnapshotLease<SnapshotJournalArchiveReaderRequest>(
      transport,
      options,
      parseSnapshotJournalArchiveReaderRequest
    )
  try {
    const issued = await lease.run(signal =>
      transport.offer({ lifetimeMs: lease.lifetimeMs, maxBytes: snapshotArchiveLimits.archiveBytes }, position, signal)
    )
    if (issued.outcome === 'resource-limited') {
      await lease.close()
      return undefined
    }
    const { offer, request } = issued
    lease.bindServerTime(offer.serverTime)
    lease.own(request)
    const admitted = await lease.runIdempotent(signal => transport.admit(request, signal))
    if (admitted.outcome === 'resource-limited') {
      await lease.close()
      return undefined
    }
    let receipt = admitted.receipt
    function* intervals() {
      let delay = 100
      while (receipt.state === 'building') {
        yield delay
        delay = Math.min(delay * 2, 1000)
      }
    }
    await runInSeries(intervals(), async delay => {
      await lease.wait(delay)
      receipt = await lease.runIdempotent(signal => transport.status(request, signal))
    })
    if (receipt.state === 'resource-limited') {
      await lease.close()
      return undefined
    }
    if (receipt.state !== 'ready') throw new WERR_INVALID_OPERATION(`Journal archive capture is ${receipt.state}`)
    const directory = await lease.runIdempotent(signal =>
      transport.directory(request, receipt, offer, lease.now(), signal)
    )
    const assertFresh = (): void => {
      if (lease.now() >= directory.manifest.expiresAt)
        throw new WERR_INVALID_OPERATION('Remote journal artifact expired')
    }
    assertFresh()
    return Object.freeze({
      get manifest() {
        return { ...directory.manifest, binding: parseSnapshotJournalArchiveBinding(JSON.parse(directory.bindingJson)) }
      },
      frameCount: directory.frames.length,
      expiresAt: lease.expiresAt,
      get isOpen() {
        return lease.isOpen
      },
      closed: lease.closed,
      close: () => lease.close(),
      readFrame: async (
        ordinal: number,
        captureIdentities: (
          frameDigest: string,
          changeIndex: number,
          identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
        ) => Promise<void>
      ) =>
        await lease.run(async signal => {
          assertFresh()
          if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= directory.frames.length)
            throw new TypeError('Invalid journal artifact frame ordinal')
          const index = directory.frames[ordinal],
            stream = snapshotJournalArchiveStreams[index.streamIndex]
          const read = async (sequence: number) =>
            decodeSnapshotJournalArchivePacket(
              await transport.page(request, directory, sequence, signal),
              { stream: stream.stream, tableId: stream.tableId },
              directory.manifest.binding.journal.receipt.highWater
            )
          // Verify the frame before offering any prefix to the real destination.
          const frame = await read(index.sequence)
          if (
            frame.kind !== 'frame' ||
            frame.page.changes.length !== directory.receipts[index.sequence].rows ||
            frame.page.complete !== directory.receipts[index.sequence].done
          )
            throw new TypeError('Journal artifact frame differs from its directory')
          function* prefixes() {
            for (let sequence = index.firstPrefix; sequence < index.sequence; sequence++) yield sequence
          }
          await runInSeries(prefixes(), async sequence => {
            const prefix = await read(sequence)
            if (prefix.kind === 'frame' || prefix.frameDigest !== frame.frameDigest)
              throw new TypeError('Journal artifact prefix differs from its frame')
            const groups = prefix.kind === 'identities' ? [prefix] : prefix.groups
            await runInSeries(groups, async group => {
              if (group.changeIndex >= frame.page.changes.length)
                throw new TypeError('Journal artifact identity index exceeds its frame')
              lease.assertOpen()
              assertFresh()
              await captureIdentities(frame.frameDigest, group.changeIndex, group.identities)
            })
          })
          assertFresh()
          return { page: frame.page, frameDigest: frame.frameDigest, stream: stream.stream, tableId: stream.tableId }
        })
    })
  } catch (error) {
    try {
      await lease.close()
    } catch (cleanup) {
      throw new RemoteSnapshotOpeningCleanupError(error, cleanup)
    }
    throw error
  }
}
