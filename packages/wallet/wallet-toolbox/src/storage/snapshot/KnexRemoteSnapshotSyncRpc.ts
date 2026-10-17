import type { Knex } from 'knex'
import { KnexSyncTransferStore } from '../remoting/KnexSyncTransferStore'
import { validateSyncProofs } from '../remoting/validateRpcSyncProofs'
import { detachSnapshotSyncPage } from './SnapshotSyncRows'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncTable } from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'
import { syncTransferDigest } from '../remoting/SyncTransfer'
import type { StorageKnex } from '../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import {
  parseRemoteSnapshotSyncSource,
  parseRemoteSnapshotSyncCheckpoint,
  parseRemoteSnapshotSyncPage,
  parseRemoteSnapshotSyncCommit,
  parseRemoteSnapshotSyncStagedPage,
  parseRemoteSnapshotSyncTransfer,
  remoteSnapshotStorageKey,
  remoteSnapshotSyncCapabilities,
  remoteSnapshotSyncMethods,
  remoteSnapshotSyncFrameBytes,
  remoteSnapshotSyncInlineFrameBytes,
  remoteSnapshotSyncPartBytes,
  type RemoteSnapshotSyncMethod
} from './RemoteSnapshotSyncProtocol'
import type { SnapshotSyncStorage } from './SnapshotSync'
import { isSyncChain } from '../sync/syncFailure'

/** Stateless authenticated destination controller. Sessions, mappings, primary
 * fencing and page ACKs belong to the existing SQL transaction/schema, so any
 * replica can observe the actual outcome after a lost HTTP acknowledgement. */
export class KnexRemoteSnapshotSyncRpc {
  private readonly database: Knex
  private readonly transfers: KnexSyncTransferStore
  private stopped = false
  private readonly operations = new Set<Promise<unknown>>()
  constructor(private readonly storage: StorageKnex) {
    this.database = storage.knex
    this.transfers = new KnexSyncTransferStore(this.database, {
      version: 1,
      maxBytes: remoteSnapshotSyncFrameBytes,
      partBytes: remoteSnapshotSyncPartBytes
    })
  }
  private current(): void {
    if (this.stopped || this.storage.knex !== this.database)
      throw new WERR_INVALID_OPERATION('Remote snapshot destination is closed or replaced')
  }
  private async destination(): Promise<SnapshotSyncStorage> {
    this.current()
    const destination = this.storage.getSnapshotSync()
    if (destination === undefined || !(await destination.supportsDestination()))
      throw new WERR_INVALID_OPERATION('Remote snapshot destination schema is unavailable')
    this.current()
    return destination
  }
  private async validatePage(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ): Promise<WalletSnapshotPage<SnapshotSyncTable>> {
    const chunk = detachSnapshotSyncPage(checkpoint, page).chunk
    // Apply the existing RPC active-chain proof policy before any destination
    // SQL writer. Keep typed binary buffers instead of legacy number[] copies.
    await validateSyncProofs(this.storage, chunk.provenTxs ?? [])
    this.current()
    return {
      ...page,
      rows: chunk[snapshotSyncTables[checkpoint.tableIndex]] as unknown as WalletSnapshotPage<SnapshotSyncTable>['rows']
    }
  }
  async capabilities() {
    this.current()
    const destination = this.storage.getSnapshotSync()
    if (destination === undefined || !(await destination.supportsDestination())) return undefined
    for (const table of ['sync_transfers', 'sync_transfer_parts'])
      if (!(await this.database.schema.hasTable(table)))
        throw new WERR_INVALID_OPERATION('Remote snapshot transfer migration is incomplete')
    if ((await this.database('sync_transfers').where({ slot: 0 }).select('slot').limit(2)).length !== 1)
      throw new WERR_INVALID_OPERATION('Remote snapshot transfer quota owner is unavailable')
    this.current()
    return remoteSnapshotSyncCapabilities
  }
  dispatch(method: RemoteSnapshotSyncMethod, params: unknown[], authenticatedIdentity: string): Promise<unknown> {
    this.current()
    if (!remoteSnapshotSyncMethods.includes(method)) throw new TypeError('Unknown remote snapshot destination method')
    if (this.operations.size >= 8)
      throw new SnapshotResourceLimitError('Remote snapshot controller operation quota reached')
    const operation = this.execute(method, params, authenticatedIdentity)
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    )
    return operation
  }
  private async execute(
    method: RemoteSnapshotSyncMethod,
    params: unknown[],
    authenticatedIdentity: string
  ): Promise<unknown> {
    const deadline = performance.now() + remoteSnapshotSyncCapabilities.maxIoMs
    const requireIoDeadline = (): void => {
      if (performance.now() >= deadline) throw new WERR_INVALID_OPERATION('Remote snapshot server I/O deadline reached')
    }
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(authenticatedIdentity)) throw new WERR_UNAUTHORIZED()
    if (!Array.isArray(params) || params.length !== 2)
      throw new TypeError('Invalid remote snapshot destination arguments')
    const chain = this.storage.chain
    if (!isSyncChain(chain)) throw new WERR_INVALID_OPERATION('Remote snapshot destination network is unavailable')
    // Detach identity/source admission before the first asynchronous boundary.
    const source =
      method === 'beginSnapshotSync'
        ? parseRemoteSnapshotSyncSource(params[0], authenticatedIdentity, chain)
        : undefined
    const activeStorage = source === undefined || params[1] == null ? undefined : remoteSnapshotStorageKey(params[1])
    const sourceIdentity =
      source?.sourceStorage.storageIdentityKey ??
      (method === 'getSnapshotSyncCheckpoint'
        ? remoteSnapshotStorageKey(params[1])
        : remoteSnapshotStorageKey(
            Object.getOwnPropertyDescriptor(params[0] as object, 'sourceStorageIdentityKey')?.value
          ))
    if (method === 'getSnapshotSyncCheckpoint' && params[0] !== authenticatedIdentity) throw new WERR_UNAUTHORIZED()
    const hasCheckpoint = method !== 'beginSnapshotSync' && method !== 'getSnapshotSyncCheckpoint'
    const checkpoint = hasCheckpoint
      ? parseRemoteSnapshotSyncCheckpoint(params[0], {
          identityKey: authenticatedIdentity,
          sourceStorageIdentityKey: sourceIdentity,
          destinationStorageIdentityKey: remoteSnapshotStorageKey(
            Object.getOwnPropertyDescriptor(params[0] as object, 'destinationStorageIdentityKey')?.value
          )
        })
      : undefined
    const transfer =
      hasCheckpoint && method !== 'commitSnapshotSyncPage'
        ? parseRemoteSnapshotSyncTransfer(params[1], method)
        : undefined
    const frame = method === 'commitSnapshotSyncPage' ? params[1] : undefined
    if (
      method === 'commitSnapshotSyncPage' &&
      (!(frame instanceof Uint8Array) || frame.length < 1 || frame.length > remoteSnapshotSyncInlineFrameBytes)
    )
      throw new TypeError('Invalid bounded remote snapshot frame')
    const detachedFrame = frame instanceof Uint8Array ? new Uint8Array(frame) : undefined
    if (method === 'releaseSnapshotSyncPageTransfer') {
      // Authenticated cleanup remains legal after source expiry/replacement.
      await this.transfers.release(authenticatedIdentity, transfer!.transferId!)
      return true
    }
    const adapter = await this.destination(),
      settings = await this.storage.makeAvailable()
    this.current()
    requireIoDeadline()
    if (
      chain !== this.storage.chain ||
      settings.chain !== chain ||
      (checkpoint !== undefined && checkpoint.destinationStorageIdentityKey !== settings.storageIdentityKey)
    )
      throw new WERR_INVALID_OPERATION('Remote snapshot destination identity/network changed')
    if (source !== undefined) {
      const result = await adapter.begin(source, activeStorage, { maximumSourceScopes: 8 })
      this.current()
      return result
    }
    if (method === 'getSnapshotSyncCheckpoint') {
      const result = await adapter.checkpoint(authenticatedIdentity, sourceIdentity)
      this.current()
      return result ?? null
    }
    if (checkpoint === undefined || checkpoint.done)
      throw new WERR_INVALID_OPERATION('Remote snapshot commit has no open checkpoint')
    const sessions = await this.database('snapshot_sync_sessions')
      .where({
        identityKey: authenticatedIdentity,
        sourceStorageIdentityKey: sourceIdentity,
        sessionId: checkpoint.sessionId
      })
      .select('sourceUserId', 'expiresAt', 'sequence', 'tableIndex', 'snapshotId')
      .limit(2)
    this.current()
    const row = sessions[0]
    if (
      sessions.length !== 1 ||
      Number(row.expiresAt) <= Date.now() ||
      row.snapshotId !== checkpoint.snapshotId ||
      Number(row.sequence) !== checkpoint.sequence ||
      Number(row.tableIndex) !== checkpoint.tableIndex
    )
      throw new WERR_INVALID_OPERATION('Remote snapshot original session changed or expired')
    requireIoDeadline()
    if (method === 'beginSnapshotSyncPageTransfer')
      return await this.transfers.beginWrite(
        authenticatedIdentity,
        transfer!.digest!,
        transfer!.totalBytes!,
        Number(row.expiresAt)
      )
    if (method === 'writeSnapshotSyncPageTransferPart')
      return await this.transfers.write(
        authenticatedIdentity,
        transfer!.transferId!,
        transfer!.offset!,
        transfer!.bytes!
      )
    if (method === 'commitSnapshotSyncPageTransfer') {
      const staged = await this.transfers.loadWrite(authenticatedIdentity, transfer!.transferId!)
      if (staged.result !== undefined) return parseRemoteSnapshotSyncCommit(staged.result, checkpoint)
      try {
        const page = await this.validatePage(
            checkpoint,
            parseRemoteSnapshotSyncStagedPage(staged.bytes, checkpoint, row.sourceUserId)
          ),
          digest = syncTransferDigest(staged.bytes),
          apply = await this.storage.prepareSnapshotSyncPageInTransaction(checkpoint, page)
        this.current()
        requireIoDeadline()
        const result = await this.transfers.commitPreparedWrite(
          authenticatedIdentity,
          transfer!.transferId!,
          digest,
          apply
        )
        this.current()
        return result
      } finally {
        staged.bytes.fill(0)
      }
    }
    const page = await this.validatePage(
      checkpoint,
      parseRemoteSnapshotSyncPage(detachedFrame, checkpoint, row.sourceUserId)
    )
    const apply = await adapter.prepare(checkpoint, page)
    this.current()
    requireIoDeadline()
    // Proof/source network work has ended. The destination rechecks its actual
    // current session/primary and commits effects plus ACK in one SQL writer.
    const result = await apply()
    this.current()
    return result
  }
  async close(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.operations)
  }
}
