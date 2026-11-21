import { awaitFromSync, mapAwaitFromSync } from '../../../utility/promiseFromSync'
import { parseSnapshotJournalDataContentReceipt } from './SnapshotJournalDataContentReceipt'
import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { SnapshotJournalDataBootstrapRequiredError } from './SnapshotJournalDataBootstrapRequiredError'
import { retrySnapshotArchiveOperation } from '../archive/SnapshotArchiveTransportFailure'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { RemoteSnapshotSyncTransferCleanupError } from '../RemoteSnapshotSyncDestination'
import {
  syncTransferDigest,
  validateSyncTransferManifest,
  type SyncTransferManifest
} from '../../remoting/SyncTransfer'
import { snapshotJournalDataRecord, snapshotJournalDataDigest } from './SnapshotJournalReceiptData'
import { parseSnapshotJournalArchiveBinding, type SnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import {
  snapshotJournalDataCapabilities,
  parseSnapshotJournalDataInput,
  parseSnapshotJournalDataStatus,
  parseSnapshotJournalDataCheckpoint,
  type SnapshotJournalDataMethod,
  type SnapshotJournalDataStatus
} from './SnapshotJournalDataProtocol'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

export type SnapshotJournalDataRpcCall = (
  method: SnapshotJournalDataMethod,
  params: unknown[],
  signal: AbortSignal
) => Promise<unknown>

/** An authenticated target window, opened by real RPC. No SQL source actor or
 * primary fence is manufactured from its binding/checkpoint DATA. One bounded
 * operation is owned until actual network and transfer cleanup settle. */
export class RemoteSnapshotJournalDataDestination {
  private busy = false
  private constructor(
    private readonly rpc: SnapshotJournalDataRpcCall,
    private readonly identityKey: string,
    private readonly sourceStorageIdentity: string,
    private readonly destinationStorageIdentity: string,
    private readonly bound: SnapshotJournalDestinationBinding,
    private readonly signal?: AbortSignal
  ) {}
  static async open(
    rpc: SnapshotJournalDataRpcCall,
    identityKey: string,
    destinationStorageIdentity: string,
    input: SnapshotJournalArchiveBinding,
    signal?: AbortSignal
  ): Promise<RemoteSnapshotJournalDataDestination> {
    const source = parseSnapshotJournalArchiveBinding(input),
      sourceStorageIdentity = source.sourceStorage.storageIdentityKey
    if (source.user.identityKey !== identityKey) throw new TypeError('Journal destination source profile differs')
    const value = await RemoteSnapshotJournalDataDestination.request(
      rpc,
      'beginSnapshotJournalData',
      { version: 1, identityKey, source },
      signal
    )
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'outcome')) {
      const outcome = snapshotJournalDataRecord(value, ['version', 'outcome'])
      if (outcome.version !== 1 || outcome.outcome !== 'bootstrap-required')
        throw new TypeError('Invalid journal destination admission refusal')
      throw new SnapshotJournalDataBootstrapRequiredError()
    }
    const actual = parseSnapshotJournalDataStatus(value, identityKey, sourceStorageIdentity, destinationStorageIdentity)
    if (
      JSON.stringify(actual.binding.source) !== JSON.stringify(source.journal.source) ||
      JSON.stringify(actual.binding.receipt) !== JSON.stringify(source.journal.receipt) ||
      actual.binding.low !== source.journal.low ||
      (actual.binding.bootstrap === true) !== source.journal.bootstrap
    )
      throw new WERR_INVALID_OPERATION('Journal destination changed the admitted source DATA')
    return new RemoteSnapshotJournalDataDestination(
      rpc,
      identityKey,
      sourceStorageIdentity,
      destinationStorageIdentity,
      actual.binding,
      signal
    )
  }
  /** Fresh observation DATA only; opening a new writer still requires BEGIN. */
  static observe(
    rpc: SnapshotJournalDataRpcCall,
    identityKey: string,
    sourceStorageIdentity: string,
    destinationStorageIdentity: string
  ): Promise<SnapshotJournalDataStatus | undefined> {
    return mapAwaitFromSync(
      () =>
        this.request(rpc, 'getSnapshotJournalDataStatus', {
          version: 1,
          identityKey,
          sourceStorageIdentity
        }),
      value => {
        return value === null
          ? undefined
          : parseSnapshotJournalDataStatus(value, identityKey, sourceStorageIdentity, destinationStorageIdentity)
      }
    )
  }

  static contentReceipt(
    rpc: SnapshotJournalDataRpcCall,
    identityKey: string,
    sourceStorageIdentity: string,
    destinationStorageIdentity: string,
    revision?: SnapshotSyncContentRevision
  ) {
    return mapAwaitFromSync(
      () =>
        this.request(
          rpc,
          revision === undefined ? 'getSnapshotJournalDataContentReceipt' : 'confirmSnapshotJournalDataContentReceipt',
          {
            version: 1,
            identityKey,
            sourceStorageIdentity,
            ...(revision === undefined ? {} : { revision: parseSnapshotSyncContentRevision(revision) })
          }
        ),
      value => {
        if (value === null) return undefined
        const receipt = parseSnapshotJournalDataContentReceipt(value)
        if (
          receipt.identityKey !== identityKey ||
          receipt.sourceStorageIdentity !== sourceStorageIdentity ||
          receipt.destinationStorageIdentity !== destinationStorageIdentity
        )
          throw new TypeError('Journal DATA receipt changed its authenticated endpoint/profile')
        return receipt
      }
    )
  }

  private static async request(
    rpc: SnapshotJournalDataRpcCall,
    method: SnapshotJournalDataMethod,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const params = [input],
      identityKey = input.identityKey
    if (typeof identityKey !== 'string') throw new TypeError('Missing journal destination identity')
    parseSnapshotJournalDataInput(method, params, identityKey)
    if (signal?.aborted) throw new SnapshotCancelledError('Remote journal request was cancelled before admission')
    const controller = new AbortController(),
      abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new WERR_INVALID_OPERATION('Remote journal I/O deadline reached')),
      snapshotJournalDataCapabilities.maxIoMs
    )
    try {
      return await retrySnapshotArchiveOperation(() => awaitFromSync(() => rpc(method, params, controller.signal)))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  private async call(
    method: SnapshotJournalDataMethod,
    fields: Record<string, unknown> = {},
    cleanup = false
  ): Promise<unknown> {
    return await RemoteSnapshotJournalDataDestination.request(
      this.rpc,
      method,
      { version: 1, identityKey: this.identityKey, sourceStorageIdentity: this.sourceStorageIdentity, ...fields },
      cleanup ? undefined : this.signal
    )
  }
  private statusValue(input: unknown): SnapshotJournalDataStatus {
    const status = parseSnapshotJournalDataStatus(
      input,
      this.identityKey,
      this.sourceStorageIdentity,
      this.destinationStorageIdentity
    )
    if (JSON.stringify(status.binding) !== JSON.stringify(this.bound))
      throw new WERR_INVALID_OPERATION('Remote journal original destination window was replaced')
    return status
  }
  get binding(): SnapshotJournalDestinationBinding {
    // Dates are absent from this closed binding; a JSON copy contains DATA only.
    return JSON.parse(JSON.stringify(this.bound)) as SnapshotJournalDestinationBinding
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new WERR_INVALID_OPERATION('Remote journal destination already has an operation in flight')
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }
  status(): Promise<SnapshotJournalDataStatus> {
    return awaitFromSync(() => {
      return this.exclusive(async () => this.statusValue(await this.call('getSnapshotJournalDataStatus', {}, true)))
    })
  }
  stagePacket(input: SnapshotJournalDestinationCheckpoint, inputBytes: Uint8Array): Promise<SnapshotJournalDataStatus> {
    return awaitFromSync(() => {
      const checkpoint = parseSnapshotJournalDataCheckpoint(input)
      const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
      if (
        !(inputBytes instanceof Uint8Array) ||
        byteLength === undefined ||
        byteLength.call(inputBytes) < 4 ||
        byteLength.call(inputBytes) > snapshotJournalDataCapabilities.maxPacketBytes
      )
        throw new TypeError('Journal destination packet exceeds its original bound')
      const bytes = new Uint8Array(inputBytes)
      return this.exclusive(async () => {
        if (bytes.length <= snapshotJournalDataCapabilities.inlinePacketBytes)
          return this.statusValue(await this.call('stageSnapshotJournalDataPacket', { checkpoint, packet: bytes }))
        const digest = syncTransferDigest(bytes)
        let transferId: string | undefined,
          result: SnapshotJournalDataStatus | undefined,
          failure: unknown,
          failed = false
        const cleanup = async (): Promise<void> => {
          if (
            transferId !== undefined &&
            (await this.call('releaseSnapshotJournalDataTransfer', { transferId }, true)) !== true
          )
            throw new TypeError('Invalid journal destination transfer release')
        }
        try {
          const row = snapshotJournalDataRecord(
            await this.call('beginSnapshotJournalDataTransfer', { checkpoint, digest, totalBytes: bytes.length }),
            ['transferId', 'digest', 'totalBytes', 'partBytes', 'expiresAt', 'receivedBytes']
          )
          transferId = snapshotJournalDataDigest(row.transferId)
          const manifest = validateSyncTransferManifest(row as unknown as SyncTransferManifest, {
            version: 1,
            maxBytes: snapshotJournalDataCapabilities.maxPacketBytes,
            partBytes: snapshotJournalDataCapabilities.partBytes
          })
          const received = row.receivedBytes
          if (
            manifest.digest !== digest ||
            manifest.totalBytes !== bytes.length ||
            manifest.expiresAt > this.bound.receipt.expiresAt ||
            typeof received !== 'number' ||
            !Number.isSafeInteger(received) ||
            received < 0 ||
            received > bytes.length ||
            (received !== bytes.length && received % manifest.partBytes !== 0)
          )
            throw new TypeError('Journal destination transfer changed its immutable bounds')
          for (let offset = received; offset < bytes.length; offset += manifest.partBytes) {
            const part = bytes.subarray(offset, Math.min(offset + manifest.partBytes, bytes.length))
            if (
              (await this.call('writeSnapshotJournalDataTransferPart', {
                checkpoint,
                transferId,
                offset,
                bytes: part
              })) !==
              offset + part.length
            )
              throw new TypeError('Journal destination part acknowledgement changed')
          }
          result = this.statusValue(await this.call('stageSnapshotJournalDataTransfer', { checkpoint, transferId }))
        } catch (error) {
          failure = error
          failed = true
        }
        try {
          await cleanup()
        } catch (error) {
          throw new RemoteSnapshotSyncTransferCleanupError(failure, error, cleanup)
        }
        if (failed) throw failure
        if (result === undefined) throw new WERR_INVALID_OPERATION('Journal destination has no durable packet result')
        return result
      })
    })
  }
  promote(input: SnapshotJournalDestinationCheckpoint): Promise<SnapshotJournalDataStatus> {
    return awaitFromSync(() => {
      const checkpoint = parseSnapshotJournalDataCheckpoint(input)
      return this.exclusive(async () => this.statusValue(await this.call('promoteSnapshotJournalData', { checkpoint })))
    })
  }
  cleanup(input: SnapshotJournalDestinationCheckpoint): Promise<{ removed: number; complete: boolean }> {
    return awaitFromSync(() => {
      const checkpoint = parseSnapshotJournalDataCheckpoint(input)
      return this.exclusive(async () => {
        const row = snapshotJournalDataRecord(await this.call('cleanupSnapshotJournalData', { checkpoint }, true), [
          'removed',
          'complete'
        ])
        if (
          typeof row.removed !== 'number' ||
          !Number.isSafeInteger(row.removed) ||
          row.removed < 0 ||
          typeof row.complete !== 'boolean'
        )
          throw new TypeError('Invalid journal destination cleanup result')
        return { removed: row.removed, complete: row.complete }
      })
    })
  }
}
