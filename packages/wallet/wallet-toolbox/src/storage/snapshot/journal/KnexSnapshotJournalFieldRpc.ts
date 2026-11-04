import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import { snapshotJournalFieldUploadSourceDigest } from './SnapshotJournalFieldUploadRequest'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { KnexSyncTransferStore } from '../../remoting/KnexSyncTransferStore'
import { syncTransferDigest } from '../../remoting/SyncTransfer'
import { KnexSnapshotArchiveRequestStore } from '../archive/KnexSnapshotArchiveRequestStore'
import { KnexSnapshotJournalFieldDestination } from './KnexSnapshotJournalFieldDestination'
import { snapshotJournalRpcQueueFor } from './KnexSnapshotJournalDataRpc'
import { SnapshotJournalDataBootstrapRequiredError } from './SnapshotJournalDataBootstrapRequiredError'
import { journalCopyLimits } from './SnapshotJournalCopyLimits'
import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import { decodeSnapshotJournalFieldArchivePacket } from './SnapshotJournalArchivePacket'
import { openStoredSnapshotJournalFieldArchive } from './openStoredSnapshotJournalFieldArchive'
import {
  parseSnapshotJournalFieldRpcInput,
  snapshotJournalFieldRpcCapabilities,
  type SnapshotJournalFieldRpcMethod
} from './SnapshotJournalFieldRpcProtocol'
import type { SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'

/** Real authenticated field target. Durable upload ownership and actual SQL
 * financial windows remain separate. Any replica can resume both; packets,
 * upload READY and sender cursors never acknowledge financial completion. */
export class KnexSnapshotJournalFieldRpc {
  private readonly root: Knex
  private readonly requests: KnexSnapshotArchiveRequestStore
  private readonly transfers: KnexSyncTransferStore
  private readonly operations = new Set<Promise<unknown>>()
  private stopped = false
  constructor(private readonly storage: StorageKnex) {
    this.root = storage.knex
    // No wallet source is opened by an upload, so there is no retained source
    // actor/guard to mint or release here. The SQL request owner is durable.
    this.requests = new KnexSnapshotArchiveRequestStore(this.root)
    this.transfers = new KnexSyncTransferStore(this.root, {
      version: 1,
      maxBytes: snapshotJournalFieldRpcCapabilities.maxPacketBytes,
      partBytes: snapshotJournalFieldRpcCapabilities.partBytes
    })
  }
  private current() {
    if (this.stopped || this.storage.knex !== this.root)
      throw new WERR_INVALID_OPERATION('Field destination endpoint stopped or replaced')
  }
  async capabilities() {
    this.current()
    if (
      !(await this.storage.supportsSnapshotJournalFieldSync()) ||
      !(await this.storage.supportsSnapshotJournalDataContent())
    )
      return undefined
    for (const name of [
      'snapshot_archive_requests',
      'snapshot_archives',
      'snapshot_archive_pages',
      'snapshot_archive_capacity',
      'sync_transfers',
      'sync_transfer_parts'
    ])
      if (!(await this.root.schema.hasTable(name))) return undefined
    if ((await this.root('sync_transfers').where({ slot: 0 }).select('slot').limit(2)).length !== 1) return undefined
    this.current()
    return snapshotJournalFieldRpcCapabilities
  }
  dispatch(method: SnapshotJournalFieldRpcMethod, params: unknown[], identityKey: string) {
    this.current()
    if (this.operations.size >= 8) throw new SnapshotResourceLimitError('Field destination operation quota reached')
    const operation = this.execute(method, params, identityKey)
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    )
    return operation
  }
  private async execute(
    method: SnapshotJournalFieldRpcMethod,
    params: unknown[],
    identityKey: string
  ): Promise<unknown> {
    if (!/^(02|03)[0-9a-f]{64}$/.test(identityKey)) throw new WERR_UNAUTHORIZED()
    const input = parseSnapshotJournalFieldRpcInput(method, params, identityKey),
      deadline = performance.now() + snapshotJournalFieldRpcCapabilities.maxIoMs,
      current = () => {
        this.current()
        if (performance.now() >= deadline)
          throw new WERR_INVALID_OPERATION('Field destination original I/O deadline reached')
      },
      queue = snapshotJournalRpcQueueFor(this.root),
      admission: SnapshotJournalWriterAdmission = async (operation, observe) => {
        current()
        const leave = queue.admit()
        let release: (() => void) | undefined
        try {
          release = await queue.acquire('exclusive', observe === 'observe' ? 'foreground' : 'background')
          current()
          return await operation()
        } finally {
          release?.()
          leave()
        }
      }
    // Both cleanup operations retain authentication but tolerate original expiry.
    if (method === 'cancelSnapshotJournalFieldUpload') {
      await this.requests.cancelJournalFieldUpload(identityKey, input.request!)
      this.current()
      return true
    }
    if (method === 'releaseSnapshotJournalFieldTransfer') {
      await this.transfers.release(identityKey, input.transferId!)
      this.current()
      return true
    }
    if ((await this.capabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Field destination protocol is unavailable')
    current()
    const options = { admission },
      sourceIdentity = input.source?.sourceStorage.storageIdentityKey ?? input.sourceStorageIdentity!
    if (
      input.source !== undefined &&
      (input.source.sourceStorage.chain !== this.storage.chain ||
        sourceIdentity === this.storage.getSettings().storageIdentityKey)
    )
      throw new WERR_UNAUTHORIZED('Field upload endpoint/network differs')
    if (method === 'findSnapshotJournalFieldUpload') {
      const found = await this.requests.findJournalFieldUpload(identityKey, sourceIdentity)
      if (found === undefined) return null
      const destination = await KnexSnapshotJournalFieldDestination.resume(
        this.storage,
        identityKey,
        sourceIdentity,
        journalCopyLimits(),
        admission
      )
      if (
        destination === undefined ||
        JSON.stringify(destination.binding.source) !== JSON.stringify(found.source.journal.source) ||
        JSON.stringify(destination.binding.receipt) !== JSON.stringify(found.source.journal.receipt) ||
        destination.binding.low !== found.source.journal.low ||
        (destination.binding.bootstrap === true) !== found.source.journal.bootstrap
      )
        throw new WERR_INVALID_OPERATION('Stored upload differs from its actual current financial window')
      await destination.status()
      current()
      return found
    }
    if (method === 'getSnapshotJournalFieldStatus') {
      const result = await this.storage.getSnapshotJournalFieldStatus(identityKey, sourceIdentity, options)
      current()
      return result === undefined ? null : { version: 1, ...result }
    }
    if (method === 'getSnapshotJournalFieldContentReceipt' || method === 'confirmSnapshotJournalFieldContentReceipt') {
      const result =
        method === 'getSnapshotJournalFieldContentReceipt'
          ? await this.storage.getSnapshotJournalFieldContentReceipt(identityKey, sourceIdentity, options)
          : await this.storage.confirmSnapshotJournalFieldContentReceipt(
              identityKey,
              sourceIdentity,
              input.revision!,
              options
            )
      current()
      return result ?? null
    }
    if (
      input.request !== undefined &&
      input.source !== undefined &&
      input.request.sourceDigest !== snapshotJournalFieldUploadSourceDigest(input.source)
    )
      throw new WERR_UNAUTHORIZED('Field upload differs from its actual admitted source')
    if (method === 'getSnapshotJournalFieldUploadStatus') {
      const result = await this.requests.journalFieldUploadStatus(identityKey, input.request!)
      current()
      return result
    }
    if (method === 'offerSnapshotJournalFieldUpload') {
      const offer = await this.requests.offerJournalFieldUpload(identityKey, input.source!)
      current()
      return offer === undefined
        ? { version: 1, outcome: 'resource-limited' }
        : { version: 1, outcome: 'offered', ...offer }
    }
    // Claim the real durable upload before any financial BEGIN. Cancellation
    // and every financial writer share its transaction fence across replicas.
    const writer = await this.requests.beginJournalFieldUpload(identityKey, input.request!, input.source!),
      owner = await this.requests.journalFieldUploadOwner(identityKey, input.request!)
    let destination: KnexSnapshotJournalFieldDestination
    try {
      if (method === 'resumeSnapshotJournalFieldUpload') {
        const existing = await KnexSnapshotJournalFieldDestination.resume(
          this.storage,
          identityKey,
          sourceIdentity,
          journalCopyLimits(),
          admission,
          undefined,
          undefined,
          owner
        )
        if (
          existing === undefined ||
          JSON.stringify(existing.binding.source) !== JSON.stringify(input.source!.journal.source) ||
          JSON.stringify(existing.binding.receipt) !== JSON.stringify(input.source!.journal.receipt) ||
          existing.binding.low !== input.source!.journal.low ||
          (existing.binding.bootstrap === true) !== input.source!.journal.bootstrap
        )
          throw new WERR_INVALID_OPERATION('Field upload recovery cannot replace its original financial window')
        await this.requests.journalFieldUploadOwner(identityKey, input.request!)
        destination = existing
      } else {
        destination = (
          await KnexSnapshotJournalFieldDestination.begin(
            this.storage,
            identityKey,
            input.source!,
            journalCopyLimits(),
            admission,
            undefined,
            owner
          )
        ).destination
      }
    } catch (cause) {
      if (method === 'beginSnapshotJournalFieldUpload' && cause instanceof SnapshotJournalDataBootstrapRequiredError)
        return { version: 1, outcome: 'bootstrap-required' }
      throw cause
    }
    const status = async () => {
        const actual = await destination.status()
        current()
        return { version: 1, binding: destination.binding, ...actual }
      },
      context = () =>
        syncTransferDigest(
          new TextEncoder().encode(
            JSON.stringify([
              'wallet-journal-field-upload-transfer/1',
              input.request!.requestId,
              input.sequence!,
              input.streamIndex!
            ])
          )
        ),
      append = async (bytes: Uint8Array) => {
        current()
        const stream = snapshotJournalArchiveStreams[input.streamIndex!],
          packet = decodeSnapshotJournalFieldArchivePacket(
            bytes,
            { stream: stream.stream, tableId: stream.tableId },
            input.source!.journal.receipt.highWater
          ),
          frame = packet.kind === 'field-frame' ? packet : undefined
        await this.requests.appendJournalFields(owner, writer, {
          sequence: input.sequence!,
          table: stream.table,
          bytes,
          rows: frame?.page.changes.length ?? 0,
          done: frame?.page.complete ?? false
        })
        current()
        return true
      }
    if (method === 'beginSnapshotJournalFieldUpload' || method === 'resumeSnapshotJournalFieldUpload')
      return await status()
    if (method === 'appendSnapshotJournalFieldPacket') return await append(input.packet!)
    if (method === 'beginSnapshotJournalFieldTransfer')
      return await this.transfers.beginWrite(
        identityKey,
        input.digest!,
        input.totalBytes!,
        input.request!.notAfter,
        context()
      )
    if (method === 'writeSnapshotJournalFieldTransferPart')
      return await this.transfers.write(identityKey, input.transferId!, input.offset!, input.bytes!, context())
    if (method === 'appendSnapshotJournalFieldTransfer') {
      const staged = await this.transfers.loadWrite(identityKey, input.transferId!, context())
      try {
        if (staged.result !== undefined)
          throw new WERR_INVALID_OPERATION('Field packet transfer was consumed by another protocol')
        return await append(staged.bytes)
      } finally {
        staged.bytes.fill(0)
      }
    }
    if (method === 'sealSnapshotJournalFieldUpload') {
      const result = await this.requests.sealJournalFields(owner, writer)
      current()
      return { version: 1, archiveId: result.archiveId, digest: result.digest, expiresAt: result.expiresAt }
    }
    if (method !== 'stageSnapshotJournalFieldFrame' && method !== 'promoteSnapshotJournalFields')
      throw new TypeError('Unknown field destination operation')
    // Reopen only this authenticated READY SQL artifact. The reader is closed
    // and drained before returning status, including a lost/failed promotion.
    const archive = await openStoredSnapshotJournalFieldArchive(this.storage, identityKey, input.request!, {
      lifetimeMs: snapshotJournalFieldRpcCapabilities.maxIoMs
    })
    if (archive === undefined) throw new WERR_INVALID_OPERATION('Actual field upload reader is unavailable')
    let result: Awaited<ReturnType<typeof status>> | undefined, failure: { cause: unknown } | undefined
    try {
      if (method === 'stageSnapshotJournalFieldFrame') await destination.stageArchiveFrame(input.checkpoint!, archive)
      else await destination.promote(input.checkpoint!, archive)
      result = await status()
    } catch (cause) {
      failure = { cause }
    }
    try {
      await closeSnapshotJournalSource(archive)
    } catch (cleanup) {
      if (failure !== undefined && cleanup !== failure.cause)
        throw new AggregateError(
          [failure.cause, cleanup],
          'Field endpoint operation and actual reader cleanup failed',
          { cause: failure.cause }
        )
      throw cleanup
    }
    if (failure !== undefined) throw failure.cause
    if (result === undefined) throw new WERR_INVALID_OPERATION('Field endpoint has no actual operation status')
    return result
  }
  async close() {
    this.stopped = true
    await Promise.allSettled(this.operations)
  }
}
