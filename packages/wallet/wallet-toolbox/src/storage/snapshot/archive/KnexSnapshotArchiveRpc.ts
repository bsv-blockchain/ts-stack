import { isSnapshotArchiveChain } from './SnapshotArchiveChain'
import {
  snapshotJournalFieldArchiveMethods,
  isSnapshotJournalFieldArchiveMethod,
  parseSnapshotJournalFieldArchiveRpcInput,
  snapshotJournalFieldArchiveCapabilities,
  type SnapshotJournalFieldArchiveMethod
} from '../journal/SnapshotJournalFieldArchiveProtocol'
import {
  snapshotJournalArchiveMethods,
  isSnapshotJournalArchiveMethod,
  parseSnapshotJournalArchiveRpcInput,
  snapshotJournalArchiveCapabilities,
  type SnapshotJournalArchiveMethod
} from '../journal/SnapshotJournalArchiveProtocol'
import { readSnapshotJournalCaptureConfiguration } from '../journal/SnapshotJournalLifecycle'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveReaderOffer } from './SnapshotArchiveReaderOffer'
import { SnapshotArchiveCleanupPendingError, type SnapshotArchiveCleanupPending } from './SnapshotArchiveCleanup'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import type { Knex } from 'knex'
import { KnexSnapshotArchiveService } from './KnexSnapshotArchiveService'
import { readSnapshotArchiveSourceSchema } from './KnexSnapshotArchiveSource'
import { snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import {
  parseSnapshotArchiveRpcInput,
  snapshotArchiveCapabilities,
  snapshotArchiveMethods,
  type SnapshotArchiveMethod,
  type SnapshotArchiveOffer
} from './SnapshotArchiveProtocol'

export const snapshotArchiveRpcMethods = Object.freeze([
  ...snapshotArchiveMethods,
  ...snapshotJournalArchiveMethods,
  ...snapshotJournalFieldArchiveMethods
])
export type SnapshotArchiveRpcMethod =
  SnapshotArchiveMethod | SnapshotJournalArchiveMethod | SnapshotJournalFieldArchiveMethod

/** Authenticated dispatch. The HTTP edge still owns framing, rate and body limits. */
export class KnexSnapshotArchiveRpc {
  private readonly service: KnexSnapshotArchiveService
  private readonly database: Knex
  private stopped = false

  constructor(private readonly storage: StorageKnex) {
    this.database = storage.knex
    this.service = new KnexSnapshotArchiveService(storage)
  }

  async capabilities() {
    if (
      this.stopped ||
      this.storage.knex !== this.database ||
      !isSnapshotArchiveChain(this.storage.chain) ||
      this.storage.getSnapshotSync() === undefined ||
      // The local native source does not establish the separate durable remote
      // guard/receiver contract. Keep version-one RPC negotiation on its
      // existing qualified backends until that native contract is installed.
      !(await this.storage.supportsSnapshotArchiveSource(false))
    )
      return undefined
    for (const name of [
      'snapshot_archive_requests',
      'snapshot_archive_owners',
      'snapshot_archive_owner_slots',
      'snapshot_archives',
      'snapshot_archive_pages',
      'snapshot_archive_capacity'
    ]) {
      if (!(await this.database.schema.hasTable(name))) return undefined
    }
    // Guarded ownership is required by reader admission and cross-replica
    // cancellation. Table presence alone does not prove the guard upgrade.
    for (const [table, column] of [
      ['snapshot_archive_owners', 'guardVersion'],
      ['snapshot_archive_owner_slots', 'slot'],
      ['snapshot_archive_owner_slots', 'bindingJson']
    ]) {
      if (!(await this.database.schema.hasColumn(table, column))) return undefined
    }
    return this.stopped || this.storage.knex !== this.database ? undefined : snapshotArchiveCapabilities
  }

  async journalCapabilities() {
    if ((await this.capabilities()) === undefined || !(await this.storage.supportsSnapshotJournalSync()))
      return undefined
    const configuration = await readSnapshotJournalCaptureConfiguration(this.database)
    if (this.stopped || this.storage.knex !== this.database) return undefined
    return snapshotJournalArchiveCapabilities(
      Math.min(snapshotArchiveLimits.lifetimeMs, configuration.receiptPolicy.receiptLifetimeMs)
    )
  }

  async journalFieldCapabilities() {
    if ((await this.capabilities()) === undefined || !(await this.storage.supportsSnapshotJournalSync()))
      return undefined
    const configuration = await readSnapshotJournalCaptureConfiguration(this.database)
    if (this.stopped || this.storage.knex !== this.database) return undefined
    return snapshotJournalFieldArchiveCapabilities(
      Math.min(snapshotArchiveLimits.lifetimeMs, configuration.receiptPolicy.receiptLifetimeMs)
    )
  }

  async journalFieldRecoveryVersion(): Promise<1 | undefined> {
    return (await this.journalFieldCapabilities()) === undefined ? undefined : 1
  }

  private async sourceOffer(serverTime?: number): Promise<SnapshotArchiveOffer> {
    const chain = this.storage.chain
    if (!isSnapshotArchiveChain(chain)) throw new WERR_INVALID_OPERATION('Snapshot archive chain is unavailable')
    const settings = this.storage.getSettings()
    const sourceStorageIdentityKey = settings.storageIdentityKey
    const sourceSchema = await readSnapshotArchiveSourceSchema(this.storage, this.database)
    const now = serverTime ?? (await snapshotArchiveDatabaseNow(this.database))
    if (
      this.stopped ||
      this.storage.knex !== this.database ||
      this.storage.chain !== chain ||
      this.storage.getSettings().storageIdentityKey !== sourceStorageIdentityKey
    )
      throw new WERR_INVALID_OPERATION('Snapshot archive source changed during its offer')
    return {
      version: 1,
      sourceStorageIdentityKey,
      sourceSchema,
      chain,
      serverTime: now
    }
  }

  async dispatch(
    method: SnapshotArchiveRpcMethod,
    params: unknown[],
    authenticatedIdentityKey: string
  ): Promise<unknown> {
    if (isSnapshotJournalFieldArchiveMethod(method))
      return await this.dispatchJournalFields(method, params, authenticatedIdentityKey)
    if (isSnapshotJournalArchiveMethod(method))
      return await this.dispatchJournal(method, params, authenticatedIdentityKey)
    const input = parseSnapshotArchiveRpcInput(method, params)
    if (input.identityKey !== authenticatedIdentityKey)
      throw new WERR_UNAUTHORIZED('Snapshot archive identity must match authentication')
    if ((await this.capabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Snapshot archive transport is unavailable')
    if (input.method === 'getSnapshotContentArchiveReaderOffer' || input.method === 'admitSnapshotContentArchive') {
      const adapter = this.storage.getSnapshotSync()
      if (
        adapter?.supportsContentDestination === undefined ||
        !(await adapter.supportsContentDestination()) ||
        !(await this.storage.supportsSnapshotJournalSync())
      )
        throw new WERR_INVALID_OPERATION('Snapshot content archive is not negotiated')
    }
    const identityKey = authenticatedIdentityKey
    switch (input.method) {
      case 'getSnapshotContentArchiveReaderOffer':
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
      case 'admitSnapshotContentArchive':
      case 'admitSnapshotArchive':
        return await this.service.admitReader(
          identityKey,
          input.request,
          input.method === 'admitSnapshotContentArchive'
        )
      case 'cancelSnapshotArchiveRequest':
        try {
          await this.service.cancelReader(identityKey, input.request)
          return true
        } catch (error) {
          if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
          return {
            version: 1,
            outcome: 'cleanup-pending',
            requestId: input.request.requestId
          } satisfies SnapshotArchiveCleanupPending
        }
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

  private async dispatchJournal(
    method: SnapshotJournalArchiveMethod,
    params: unknown[],
    authenticatedIdentityKey: string
  ): Promise<unknown> {
    const input = parseSnapshotJournalArchiveRpcInput(method, params)
    if (input.identityKey !== authenticatedIdentityKey)
      throw new WERR_UNAUTHORIZED('Journal archive identity must match authentication')
    if ((await this.journalCapabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Journal archive transport is unavailable')
    const identityKey = authenticatedIdentityKey
    switch (input.method) {
      case 'getSnapshotJournalArchiveReaderOffer': {
        const offer = await this.sourceOffer(),
          issued = await this.service.offerJournalReader(identityKey, input.options, input.position)
        if (issued === undefined) return { version: 1, outcome: 'resource-limited' }
        return {
          version: 1,
          outcome: 'offered',
          offer: { ...offer, serverTime: issued.serverTime },
          request: issued.request
        }
      }
      case 'admitSnapshotJournalArchive':
        return await this.service.admitJournalReader(identityKey, input.request)
      case 'getSnapshotJournalArchiveStatus':
        return await this.service.journalStatus(identityKey, input.request)
      case 'getSnapshotJournalArchiveDirectory':
      case 'readSnapshotJournalArchivePage': {
        const receipt = await this.service.journalStatus(identityKey, input.request)
        if (receipt.state !== 'ready' || receipt.archiveId !== input.archiveId)
          throw new WERR_INVALID_OPERATION('Journal archive differs from its current ready request')
        const result =
          input.method === 'getSnapshotJournalArchiveDirectory'
            ? await this.service.journalDirectory(identityKey, input.archiveId)
            : await this.service.readJournal(identityKey, input.archiveId, input.sequence)
        const current = await this.service.journalStatus(identityKey, input.request)
        if (
          current.state !== 'ready' ||
          current.archiveId !== receipt.archiveId ||
          current.digest !== receipt.digest ||
          current.expiresAt !== receipt.expiresAt
        )
          throw new WERR_INVALID_OPERATION('Journal archive closed while reading its DATA')
        return result
      }
      case 'cancelSnapshotJournalArchiveRequest':
        try {
          await this.service.cancelJournalReader(identityKey, input.request)
          return true
        } catch (error) {
          if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
          return {
            version: 1,
            outcome: 'cleanup-pending',
            requestId: input.request.requestId
          } satisfies SnapshotArchiveCleanupPending
        }
    }
  }

  private async dispatchJournalFields(
    method: SnapshotJournalFieldArchiveMethod,
    params: unknown[],
    authenticatedIdentityKey: string
  ): Promise<unknown> {
    const input = parseSnapshotJournalFieldArchiveRpcInput(method, params)
    if (input.identityKey !== authenticatedIdentityKey)
      throw new WERR_UNAUTHORIZED('Journal archive identity must match authentication')
    if ((await this.journalFieldCapabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Journal archive transport is unavailable')
    const identityKey = authenticatedIdentityKey
    if (input.method === 'reopenSnapshotJournalFieldArchive' || input.method === 'retireSnapshotJournalFieldArchive') {
      const found = await this.service.findJournalFieldsReader(
        identityKey,
        input.reference,
        input.method === 'reopenSnapshotJournalFieldArchive'
      )
      if (input.method === 'retireSnapshotJournalFieldArchive') {
        if (found !== undefined) {
          try {
            await this.service.cancelJournalFieldsReader(identityKey, found.request)
          } catch (cause) {
            if (!(cause instanceof SnapshotArchiveCleanupPendingError)) throw cause
            return {
              version: 1,
              outcome: 'cleanup-pending',
              requestId: input.reference.receipt.requestId
            } satisfies SnapshotArchiveCleanupPending
          }
        }
        return true
      }
      if (found === undefined) return { version: 1, outcome: 'absent' }
      const chain = this.storage.chain,
        settings = this.storage.getSettings()
      if (
        this.stopped ||
        this.storage.knex !== this.database ||
        !isSnapshotArchiveChain(chain) ||
        found.binding.sourceStorage.storageIdentityKey !== settings.storageIdentityKey ||
        found.binding.sourceStorage.chain !== chain
      )
        throw new WERR_INVALID_OPERATION('Original field artifact endpoint changed')
      return {
        version: 1,
        outcome: 'offered',
        request: found.request,
        offer: {
          version: 1,
          sourceStorageIdentityKey: settings.storageIdentityKey,
          sourceSchema: found.binding.sourceSchema,
          chain,
          serverTime: await snapshotArchiveDatabaseNow(this.database)
        }
      }
    }
    switch (input.method) {
      case 'getSnapshotJournalFieldArchiveReaderOffer': {
        const offer = await this.sourceOffer(),
          issued = await this.service.offerJournalFieldsReader(identityKey, input.options, input.position)
        if (issued === undefined) return { version: 1, outcome: 'resource-limited' }
        return {
          version: 1,
          outcome: 'offered',
          offer: { ...offer, serverTime: issued.serverTime },
          request: issued.request
        }
      }
      case 'admitSnapshotJournalFieldArchive':
        return await this.service.admitJournalFieldsReader(identityKey, input.request)
      case 'getSnapshotJournalFieldArchiveStatus':
        return await this.service.journalFieldsStatus(identityKey, input.request)
      case 'getSnapshotJournalFieldArchiveDirectory':
      case 'readSnapshotJournalFieldArchivePage': {
        const receipt = await this.service.journalFieldsStatus(identityKey, input.request)
        if (receipt.state !== 'ready' || receipt.archiveId !== input.archiveId)
          throw new WERR_INVALID_OPERATION('Journal archive differs from its current ready request')
        const result =
          input.method === 'getSnapshotJournalFieldArchiveDirectory'
            ? await this.service.journalFieldsDirectory(identityKey, input.archiveId)
            : await this.service.readJournalFields(identityKey, input.archiveId, input.sequence)
        const current = await this.service.journalFieldsStatus(identityKey, input.request)
        if (
          current.state !== 'ready' ||
          current.archiveId !== receipt.archiveId ||
          current.digest !== receipt.digest ||
          current.expiresAt !== receipt.expiresAt
        )
          throw new WERR_INVALID_OPERATION('Journal archive closed while reading its DATA')
        return result
      }
      case 'cancelSnapshotJournalFieldArchiveRequest':
        try {
          await this.service.cancelJournalFieldsReader(identityKey, input.request)
          return true
        } catch (error) {
          if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
          return {
            version: 1,
            outcome: 'cleanup-pending',
            requestId: input.request.requestId
          } satisfies SnapshotArchiveCleanupPending
        }
    }
  }

  close(): Promise<void> {
    this.stopped = true
    return this.service.close()
  }
}
