import { isSnapshotArchiveChain, type SnapshotArchiveChain } from '../archive/SnapshotArchiveChain'
import { promiseFromSync } from '../../../utility/promiseFromSync'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { KnexSnapshotArchiveStore } from '../archive/KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from '../archive/KnexSnapshotArchiveRequestStore'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { verifySnapshotArchivePage } from '../archive/SnapshotArchiveDirectory'
import type { SnapshotArchiveRequestReceipt } from '../archive/SnapshotArchiveRequest'
import { SnapshotJournalFieldArchiveTransport } from './SnapshotJournalFieldArchiveTransport'
import { snapshotJournalFieldArchiveCapabilities } from './SnapshotJournalFieldArchiveProtocol'
import {
  snapshotJournalFieldArchiveReaderRequestId,
  parseSnapshotJournalFieldArchiveReaderRequest,
  type SnapshotJournalFieldArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import { parseSnapshotJournalFieldUploadRequest } from './SnapshotJournalFieldUploadRequest'
import {
  verifySnapshotJournalFieldArchiveDirectory,
  type VerifiedSnapshotJournalFieldArchiveDirectory
} from './SnapshotJournalArchiveDirectory'
import { openRemoteSnapshotJournalFieldArchive } from './openRemoteSnapshotJournalFieldArchive'
import type { WalletReadSnapshotOptions } from '../WalletReadSnapshot'

/** Read an actual READY upload owned by this SQL root. This is an immutable
 * artifact reader only; it cannot issue a retained wallet view/current fence.
 * Its close drains its real reads. Persistent upload deletion remains with the
 * authenticated upload owner, so separate promotion calls can reopen it. */
export async function openStoredSnapshotJournalFieldArchive(
  storage: StorageKnex,
  identityKey: string,
  inputRequest: unknown,
  options: WalletReadSnapshotOptions = {}
) {
  const root = storage.knex,
    request = parseSnapshotJournalFieldUploadRequest(inputRequest),
    requests = new KnexSnapshotArchiveRequestStore(root),
    store = new KnexSnapshotArchiveStore(root),
    original = await requests.journalFieldUploadStatus(identityKey, request)
  if (original.state !== 'ready' || original.archiveId === undefined || original.digest === undefined)
    throw new WERR_INVALID_OPERATION('Actual field upload is not READY')
  const manifest = await store.inspectJournalFields(identityKey, original.archiveId),
    chain = manifest.binding.sourceStorage.chain,
    now = await snapshotArchiveDatabaseNow(root),
    lifetimeMs = Math.min(options.lifetimeMs ?? 30000, request.notAfter - now)
  if (!isSnapshotArchiveChain(chain) || lifetimeMs < 1 || manifest.expiresAt !== request.notAfter)
    throw new WERR_INVALID_OPERATION('Field upload expired')
  const actualChain: SnapshotArchiveChain = chain
  const fields = {
      version: 4 as const,
      nonce: request.nonce,
      notAfter: request.notAfter,
      maxBytes: request.maxBytes,
      position: request.position
    },
    reader = parseSnapshotJournalFieldArchiveReaderRequest({
      ...fields,
      requestId: snapshotJournalFieldArchiveReaderRequestId(fields)
    })
  class StoredTransport extends SnapshotJournalFieldArchiveTransport {
    private stopped = false
    constructor() {
      // The inherited network call is unreachable: all six operations below
      // perform concrete SQL ownership checks on this original root.
      super(
        () => {
          return promiseFromSync(() => {
            throw new WERR_INVALID_OPERATION('Stored artifact has no network source')
          })
        },
        identityKey,
        manifest.binding.sourceStorage.storageIdentityKey,
        actualChain,
        snapshotJournalFieldArchiveCapabilities(snapshotArchiveLimits.lifetimeMs)
      )
    }
    private async actual() {
      if (this.stopped || storage.knex !== root)
        throw new WERR_INVALID_OPERATION('Stored artifact reader stopped or replaced')
      const actual = await requests.journalFieldUploadStatus(identityKey, request)
      if (
        actual.state !== 'ready' ||
        actual.archiveId !== manifest.archiveId ||
        actual.digest !== manifest.digest ||
        actual.expiresAt !== manifest.expiresAt ||
        storage.knex !== root
      )
        throw new WERR_INVALID_OPERATION('Actual stored field artifact changed')
      return actual
    }
    override async offer() {
      await this.actual()
      return {
        version: 1 as const,
        outcome: 'offered' as const,
        offer: {
          version: 1 as const,
          sourceStorageIdentityKey: manifest.binding.sourceStorage.storageIdentityKey,
          sourceSchema: manifest.binding.sourceSchema,
          chain: actualChain,
          serverTime: await snapshotArchiveDatabaseNow(root)
        },
        request: reader
      }
    }
    override async admit() {
      return { version: 1 as const, outcome: 'accepted' as const, receipt: await this.status() }
    }
    override async status(): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
      const actual = await this.actual()
      return { ...actual, requestId: reader.requestId }
    }
    override async directory() {
      await this.actual()
      return verifySnapshotJournalFieldArchiveDirectory(
        await store.journalFieldsDirectory(identityKey, manifest.archiveId),
        {
          identityKey,
          chain: actualChain,
          sourceStorageIdentityKey: manifest.binding.sourceStorage.storageIdentityKey,
          sourceSchema: manifest.binding.sourceSchema,
          archiveId: manifest.archiveId,
          digest: manifest.digest,
          expiresAt: manifest.expiresAt,
          ...(request.position === null ? {} : { position: request.position })
        },
        await snapshotArchiveDatabaseNow(root)
      )
    }
    override async page(
      _request: SnapshotJournalFieldArchiveReaderRequest,
      directory: VerifiedSnapshotJournalFieldArchiveDirectory,
      sequence: number
    ) {
      await this.actual()
      if (directory.manifest.archiveId !== manifest.archiveId || directory.manifest.digest !== manifest.digest)
        throw new WERR_INVALID_OPERATION('Stored field directory differs from its actual artifact')
      const bytes = verifySnapshotArchivePage(
        await store.readJournalFields(identityKey, manifest.archiveId, sequence),
        directory.receipts[sequence]
      )
      await this.actual()
      return bytes
    }
    override cancelRequest() {
      return promiseFromSync(() => {
        this.stopped = true
      })
    }
  }
  return await openRemoteSnapshotJournalFieldArchive(new StoredTransport(), request.position ?? undefined, {
    ...options,
    lifetimeMs
  })
}
