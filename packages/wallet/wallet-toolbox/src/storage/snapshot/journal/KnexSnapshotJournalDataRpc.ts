import { KnexSnapshotJournalDataContentReceipts } from './KnexSnapshotJournalDataContentReceipts'
import { SnapshotJournalDataBootstrapRequiredError } from './SnapshotJournalDataBootstrapRequiredError'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { StorageAccessQueue } from '../../sync/StorageAccessQueue'
import { KnexSyncTransferStore } from '../../remoting/KnexSyncTransferStore'
import { KnexSnapshotJournalDataDestination } from './KnexSnapshotJournalDataDestination'
import { journalCopyLimits } from './SnapshotJournalCopyLimits'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'
import { snapshotJournalArchivePacketBytes } from './SnapshotJournalArchivePacket'
import {
  snapshotJournalDataCapabilities,
  snapshotJournalDataContentCapabilities,
  isSnapshotJournalDataMethod,
  parseSnapshotJournalDataInput,
  parseSnapshotJournalDataCheckpoint,
  parseSnapshotJournalDataStatus,
  type SnapshotJournalDataMethod,
  type SnapshotJournalDataStatus
} from './SnapshotJournalDataProtocol'

const queues = new WeakMap<Knex, StorageAccessQueue>()
export function snapshotJournalRpcQueueFor(root: Knex): StorageAccessQueue {
  let queue = queues.get(root)
  if (queue === undefined) {
    queue = new StorageAccessQueue()
    queues.set(root, queue)
  }
  return queue
}

/** Actual authenticated target controller. Durable windows/ACKs live in SQL,
 * independently of this process. All network/proof work precedes each physical
 * writer; no received DATA creates a source SQL fence or primary selection. */
export class KnexSnapshotJournalDataRpc {
  private readonly root: Knex
  private readonly queue: StorageAccessQueue
  private readonly transfers: KnexSyncTransferStore
  private readonly operations = new Set<Promise<unknown>>()
  private stopped = false
  constructor(private readonly storage: StorageKnex) {
    this.root = storage.knex
    this.queue = snapshotJournalRpcQueueFor(this.root)
    this.transfers = new KnexSyncTransferStore(this.root, {
      version: 1,
      maxBytes: snapshotJournalArchivePacketBytes,
      partBytes: snapshotJournalDataCapabilities.partBytes
    })
  }
  private current(): void {
    if (this.stopped || this.storage.knex !== this.root)
      throw new WERR_INVALID_OPERATION('Journal DATA endpoint is stopped or replaced')
  }
  async capabilities() {
    this.current()
    if (
      !(await this.storage.supportsSnapshotArchiveSource(false)) ||
      !(await this.storage.supportsSnapshotJournalSync())
    )
      return undefined
    await verifySnapshotJournalDestinationSchema(this.root)
    if (
      !(await this.root.schema.hasTable('sync_transfers')) ||
      !(await this.root.schema.hasTable('sync_transfer_parts'))
    )
      return undefined
    if ((await this.root('sync_transfers').where('slot', 0).select('slot').limit(2)).length !== 1) return undefined
    this.current()
    return snapshotJournalDataCapabilities
  }
  async contentCapabilities() {
    if (
      (await this.capabilities()) === undefined ||
      !(await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).supports())
    )
      return undefined
    this.current()
    return snapshotJournalDataContentCapabilities
  }
  dispatch(method: SnapshotJournalDataMethod, params: unknown[], identityKey: string): Promise<unknown> {
    this.current()
    if (!isSnapshotJournalDataMethod(method)) throw new TypeError('Unknown journal DATA method')
    if (this.operations.size >= 8) throw new SnapshotResourceLimitError('Journal DATA endpoint operation quota reached')
    const operation = this.execute(method, params, identityKey)
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    )
    return operation
  }
  private async execute(method: SnapshotJournalDataMethod, params: unknown[], identityKey: string): Promise<unknown> {
    if (!/^(02|03)[0-9a-f]{64}$/.test(identityKey)) throw new WERR_UNAUTHORIZED()
    const input = parseSnapshotJournalDataInput(method, params, identityKey),
      deadline = performance.now() + snapshotJournalDataCapabilities.maxIoMs
    const current = (): void => {
      this.current()
      if (performance.now() >= deadline) throw new WERR_INVALID_OPERATION('Journal DATA original I/O deadline reached')
    }
    const admission = async <T>(operation: () => Promise<T>, observe?: 'observe'): Promise<T> => {
      current()
      const leave = this.queue.admit()
      let release: (() => void) | undefined
      try {
        release = await this.queue.acquire('exclusive', observe === 'observe' ? 'foreground' : 'background')
        current()
        return await operation()
      } finally {
        release?.()
        leave()
      }
    }
    // Cleanup is authenticated and expiry-tolerant. It cannot start a window or
    // advance a financial ACK, and its original transfer owner must still match.
    if (method === 'releaseSnapshotJournalDataTransfer') {
      await this.transfers.release(identityKey, input.transferId!)
      this.current()
      return true
    }
    if ((await this.capabilities()) === undefined)
      throw new WERR_INVALID_OPERATION('Journal DATA protocol is unavailable')
    current()
    if (input.source !== undefined && input.source.sourceStorage.chain !== this.storage.chain)
      throw new WERR_UNAUTHORIZED('Journal DATA network must match the current endpoint')
    let destination: KnexSnapshotJournalDataDestination | undefined
    try {
      destination =
        input.source !== undefined
          ? (
              await KnexSnapshotJournalDataDestination.begin(
                this.storage,
                identityKey,
                input.source,
                journalCopyLimits(),
                admission
              )
            ).destination
          : await KnexSnapshotJournalDataDestination.resume(
              this.storage,
              identityKey,
              input.sourceStorageIdentity,
              journalCopyLimits(),
              admission
            )
    } catch (error) {
      if (method === 'beginSnapshotJournalData' && error instanceof SnapshotJournalDataBootstrapRequiredError)
        return { version: 1, outcome: 'bootstrap-required' }
      throw error
    }
    current()
    if (destination === undefined) {
      if (
        method === 'getSnapshotJournalDataStatus' ||
        method === 'getSnapshotJournalDataContentReceipt' ||
        method === 'confirmSnapshotJournalDataContentReceipt'
      )
        return null
      throw new WERR_INVALID_OPERATION('Journal DATA has no actual destination window')
    }
    const status = async (): Promise<SnapshotJournalDataStatus> => {
      const actual = await destination.status()
      current()
      return { version: 1, binding: destination.binding, ...actual }
    }
    if (method === 'beginSnapshotJournalData' || method === 'getSnapshotJournalDataStatus') return await status()
    if (method === 'getSnapshotJournalDataContentReceipt') {
      const result = await destination.previousContentReceipt()
      current()
      return result ?? null
    }
    if (method === 'confirmSnapshotJournalDataContentReceipt') {
      const result = await destination.confirmContentReceipt(input.revision!)
      current()
      return result ?? null
    }
    const expected = input.checkpoint
    if (expected === undefined) throw new WERR_INVALID_OPERATION('Journal DATA operation has no checkpoint')
    const actual = await destination.status()
    if (JSON.stringify(actual.checkpoint) !== JSON.stringify(expected)) {
      // Compare detached canonical fields, not incoming property order.
      if (JSON.stringify(parseSnapshotJournalDataCheckpoint(actual.checkpoint)) !== JSON.stringify(expected))
        throw new WERR_INVALID_OPERATION('Journal DATA original destination checkpoint changed')
    }
    current()
    switch (method) {
      case 'stageSnapshotJournalDataPacket':
        await destination.stagePacket(expected, input.packet!)
        return await status()
      case 'promoteSnapshotJournalData':
        await destination.promote(expected)
        return await status()
      case 'cleanupSnapshotJournalData': {
        const result = await destination.cleanup(expected)
        current()
        return result
      }
      case 'beginSnapshotJournalDataTransfer':
        return await this.transfers.beginWrite(
          identityKey,
          input.digest!,
          input.totalBytes!,
          destination.binding.receipt.expiresAt
        )
      case 'writeSnapshotJournalDataTransferPart':
        return await this.transfers.write(identityKey, input.transferId!, input.offset!, input.bytes!)
      case 'stageSnapshotJournalDataTransfer': {
        const staged = await this.transfers.loadWrite(identityKey, input.transferId!)
        try {
          current()
          if (staged.result !== undefined) {
            const result = await status(),
              cached = parseSnapshotJournalDataStatus(
                staged.result,
                identityKey,
                input.sourceStorageIdentity,
                destination.binding.destinationStorageIdentity
              )
            if (
              JSON.stringify(cached.checkpoint) !==
                JSON.stringify(parseSnapshotJournalDataCheckpoint(result.checkpoint)) ||
              JSON.stringify(cached.binding) !== JSON.stringify(result.binding)
            )
              throw new WERR_INVALID_OPERATION('Journal transfer cache differs from actual destination custody')
            return result
          }
          // The real window, not transfer cache DATA, decides the financial ACK.
          await destination.stagePacket(expected, staged.bytes)
          const result = await status()
          await this.transfers.complete(identityKey, input.transferId!, result)
          current()
          return result
        } finally {
          staged.bytes.fill(0)
        }
      }
      default:
        throw new TypeError('Unknown journal DATA operation')
    }
  }
  async close(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.operations)
  }
}
