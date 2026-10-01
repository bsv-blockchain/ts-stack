import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
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

async function waitForCapture(
  transport: SnapshotArchiveTransport,
  lease: RemoteSnapshotLease,
  request: SnapshotArchiveReaderRequest,
  receipt: Readonly<SnapshotArchiveRequestReceipt>
): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
  function* intervals() {
    let interval = 100
    while (receipt.state === 'building') {
      yield interval
      interval = Math.min(interval * 2, 1000)
    }
  }
  await runInSeries(intervals(), async interval => {
    await lease.wait(interval)
    receipt = await lease.runIdempotent(signal => transport.readerStatus(request, signal))
  })
  return receipt
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
    receipt = await waitForCapture(transport, lease, request, receipt)
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
      created_at: new Date(value.created_at),
      updated_at: new Date(value.updated_at)
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
    } catch (error_) {
      throw new RemoteSnapshotOpeningCleanupError(error, error_)
    }
    throw error
  }
}
