import type { SnapshotArchiveReaderOffer } from './SnapshotArchiveReaderOffer'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import { KnexSnapshotArchiveService } from './KnexSnapshotArchiveService'
import { readSnapshotArchiveSourceSchema } from './KnexSnapshotArchiveSource'
import { snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import {
  parseSnapshotArchiveRpcInput,
  snapshotArchiveCapabilities,
  type SnapshotArchiveMethod,
  type SnapshotArchiveOffer
} from './SnapshotArchiveProtocol'

/** Authenticated dispatch. The HTTP edge still owns framing, rate and body limits. */
export class KnexSnapshotArchiveRpc {
  private readonly service: KnexSnapshotArchiveService
  private stopped = false

  constructor(private readonly storage: StorageKnex) {
    this.service = new KnexSnapshotArchiveService(storage)
  }

  async capabilities() {
    if (
      this.stopped ||
      (this.storage.chain !== 'main' && this.storage.chain !== 'test') ||
      this.storage.getSnapshotSync() === undefined ||
      !(await this.storage.supportsSnapshotArchiveSource())
    )
      return undefined
    for (const name of [
      'snapshot_archive_requests',
      'snapshot_archive_owners',
      'snapshot_archives',
      'snapshot_archive_pages',
      'snapshot_archive_capacity'
    ]) {
      if (!(await this.storage.knex.schema.hasTable(name))) return undefined
    }
    return this.stopped ? undefined : snapshotArchiveCapabilities
  }

  private async sourceOffer(serverTime?: number): Promise<SnapshotArchiveOffer> {
    const chain = this.storage.chain
    if (chain !== 'main' && chain !== 'test') throw new WERR_INVALID_OPERATION('Snapshot archive chain is unavailable')
    const sourceSchema = await readSnapshotArchiveSourceSchema(this.storage, this.storage.knex)
    const settings = this.storage.getSettings()
    return {
      version: 1,
      sourceStorageIdentityKey: settings.storageIdentityKey,
      sourceSchema,
      chain,
      serverTime: serverTime ?? (await snapshotArchiveDatabaseNow(this.storage.knex))
    }
  }

  async dispatch(method: SnapshotArchiveMethod, params: unknown[], authenticatedIdentityKey: string): Promise<unknown> {
    const input = parseSnapshotArchiveRpcInput(method, params)
    if (input.identityKey !== authenticatedIdentityKey)
      throw new WERR_UNAUTHORIZED('Snapshot archive identity must match authentication')
    if ((await this.capabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Snapshot archive transport is unavailable')
    const identityKey = authenticatedIdentityKey
    switch (input.method) {
      case 'getSnapshotArchiveReaderOffer': {
        // Read source metadata before issuing a retained request, so failed metadata
        // cannot leave a caller-owned request that was never returned.
        const offer = await this.sourceOffer()
        const issued = await this.service.offerReader(identityKey, input.options)
        if (issued === undefined)
          return { version: 1, outcome: 'resource-limited' } satisfies SnapshotArchiveReaderOffer
        return {
          version: 1,
          outcome: 'offered',
          offer: { ...offer, serverTime: issued.serverTime },
          request: issued.request
        } satisfies SnapshotArchiveReaderOffer
      }
      case 'admitSnapshotArchive':
        return await this.service.admitReader(identityKey, input.request)
      case 'cancelSnapshotArchiveRequest':
        await this.service.cancelReader(identityKey, input.request)
        return true
      case 'getSnapshotArchiveOffer':
        return await this.sourceOffer()
      case 'startSnapshotArchive':
        return await this.service.start(identityKey, input.request)
      case 'getSnapshotArchiveStatus':
        return await this.service.status(identityKey, input.requestId)
      case 'getSnapshotArchiveDirectory':
        return await this.service.directory(identityKey, input.archiveId)
      case 'readSnapshotArchivePage':
        return await this.service.read(identityKey, input.archiveId, input.sequence)
      case 'cancelSnapshotArchive':
        await this.service.cancel(identityKey, input.requestId)
        return true
    }
  }

  close(): Promise<void> {
    this.stopped = true
    return this.service.close()
  }
}
