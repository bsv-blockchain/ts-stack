import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { WalletReadSnapshot, WalletReadSnapshotOptions } from '../WalletReadSnapshot'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveRequestReceipt } from './SnapshotArchiveRequest'
import type { SnapshotArchiveReaderRequest } from './SnapshotArchiveReaderRequest'
import type { SnapshotArchiveTransport } from './SnapshotArchiveTransport'
import { RemoteSnapshotLease } from './RemoteSnapshotLease'
import { createRemoteSnapshotPageReader } from './RemoteSnapshotPageReader'

/** Preserve both failures without depending on AggregateError in native runtimes. */
export class RemoteSnapshotOpeningCleanupError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly cleanupError: unknown
  ) {
    super('Remote snapshot opening and cleanup failed')
    this.name = 'RemoteSnapshotOpeningCleanupError'
  }
}

async function accepted(
  transport: SnapshotArchiveTransport,
  lease: RemoteSnapshotLease,
  request: SnapshotArchiveReaderRequest
): Promise<Readonly<SnapshotArchiveRequestReceipt> | undefined> {
  // The exact durable tuple deduplicates admission; never renew or recapture.
  const result = await lease.runIdempotent(signal => transport.admit(request, signal))
  return result.outcome === 'accepted' ? result.receipt : undefined
}

/** Unsupported capacity may decline only before a source view is exposed. */
export async function openRemoteSnapshot(
  transport: SnapshotArchiveTransport,
  options: WalletReadSnapshotOptions = {}
): Promise<WalletReadSnapshot | undefined> {
  if (!transport.supportsReader) return undefined
  const lease = new RemoteSnapshotLease(transport, options)
  try {
    const issued = await lease.run(signal =>
      transport.readerOffer({ lifetimeMs: lease.lifetimeMs, maxBytes: snapshotArchiveLimits.archiveBytes }, signal)
    )
    if (issued.outcome === 'resource-limited') {
      await lease.close()
      return undefined
    }
    const { offer, request } = issued
    lease.bindServerTime(offer.serverTime)
    lease.own(request)
    let receipt = await accepted(transport, lease, request)
    if (receipt === undefined) {
      await lease.close()
      return undefined
    }
    let interval = 100
    while (receipt.state === 'building') {
      await lease.wait(interval)
      receipt = await lease.runIdempotent(signal => transport.readerStatus(request, signal))
      interval = Math.min(interval * 2, 1000)
    }
    if (receipt.state === 'resource-limited') {
      await lease.close()
      return undefined
    }
    if (receipt.state !== 'ready') throw new WERR_INVALID_OPERATION(`Snapshot archive capture is ${receipt.state}`)
    const directory = await lease.runIdempotent(signal => transport.directory(receipt, offer, lease.now(), signal))
    if (lease.now() >= directory.manifest.expiresAt) throw new WERR_INVALID_OPERATION('Remote snapshot expired')
    const binding = directory.manifest.binding
    const copyDates = <T extends { created_at: Date; updated_at: Date }>(value: T): T => ({
      ...value,
      created_at: new Date(value.created_at.getTime()),
      updated_at: new Date(value.updated_at.getTime())
    })
    return Object.freeze({
      version: 1 as const,
      snapshotId: binding.snapshotId,
      get sourceStorage() {
        return copyDates(binding.sourceStorage)
      },
      get user() {
        return copyDates(binding.user)
      },
      expiresAt: lease.expiresAt,
      get isOpen() {
        return lease.isOpen
      },
      closed: lease.closed,
      close: () => lease.close(),
      readPage: createRemoteSnapshotPageReader(transport, directory, lease)
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
