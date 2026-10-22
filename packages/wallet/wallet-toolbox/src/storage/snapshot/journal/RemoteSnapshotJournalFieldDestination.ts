import { promiseFromSync, awaitFromSync, awaitVoidFromSync, mapAwaitFromSync } from '../../../utility/promiseFromSync'
import {
  runSnapshotJournalReconciliation,
  type SnapshotJournalReconciliationOptions,
  type SnapshotJournalReconciliationProgress
} from './runSnapshotJournalReconciliation'
import { validateSnapshotArchiveRequestReceipt } from '../archive/SnapshotArchiveProtocol'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { retrySnapshotArchiveOperation } from '../archive/SnapshotArchiveTransportFailure'
import { RemoteSnapshotSyncTransferCleanupError } from '../RemoteSnapshotSyncDestination'
import {
  syncTransferDigest,
  validateSyncTransferManifest,
  type SyncTransferManifest
} from '../../remoting/SyncTransfer'
import { SnapshotJournalDataBootstrapRequiredError } from './SnapshotJournalDataBootstrapRequiredError'
import { parseSnapshotJournalDataContentReceipt } from './SnapshotJournalDataContentReceipt'
import {
  parseSnapshotJournalDataStatus,
  parseSnapshotJournalDataCheckpoint,
  type SnapshotJournalDataStatus
} from './SnapshotJournalDataProtocol'
import {
  parseSnapshotJournalFieldArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalFieldArchiveBinding
} from './SnapshotJournalArchiveBinding'
import {
  parseSnapshotJournalFieldUploadRequest,
  snapshotJournalFieldUploadSourceDigest,
  type SnapshotJournalFieldUploadRequest
} from './SnapshotJournalFieldUploadRequest'
import { snapshotJournalDataRecord, snapshotJournalDataDigest } from './SnapshotJournalReceiptData'
import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import {
  parseSnapshotJournalFieldRpcInput,
  snapshotJournalFieldRpcCapabilities as limits,
  type SnapshotJournalFieldRpcMethod
} from './SnapshotJournalFieldRpcProtocol'
import {
  encodeSnapshotJournalFieldArchiveIdentities,
  encodeSnapshotJournalFieldArchiveContent,
  encodeSnapshotJournalFieldArchiveFrame
} from './SnapshotJournalArchivePacket'
import {
  assertRemoteSnapshotJournalFieldArchive,
  type RemoteSnapshotJournalFieldArchive
} from './openRemoteSnapshotJournalFieldArchive'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

/** Safe-to-persist comparison DATA. It contains no SQL writer token or source
 * actor; resumption still requires authentication and its actual stored upload. */
export interface SnapshotJournalFieldUploadResume {
  version: 1
  source: SnapshotJournalFieldArchiveBinding
  request: Readonly<SnapshotJournalFieldUploadRequest>
}

export type SnapshotJournalFieldRpcCall = (
  method: SnapshotJournalFieldRpcMethod,
  params: unknown[],
  signal: AbortSignal
) => Promise<unknown>

/** Authenticated remote receiver. Only its actual SQL status can acknowledge
 * financial effects; the entire upload is immutable DATA with separate cleanup. */
export class RemoteSnapshotJournalFieldDestination {
  private pending: Promise<unknown> | undefined
  private closing: Promise<void> | undefined
  private uploaded: RemoteSnapshotJournalFieldArchive | undefined
  private ready = false
  private resolveClosed!: () => void
  private rejectClosed!: (cause: unknown) => void
  readonly closed = new Promise<void>((resolve, reject) => {
    this.resolveClosed = resolve
    this.rejectClosed = reject
  })

  private constructor(
    private readonly rpc: SnapshotJournalFieldRpcCall,
    private readonly identityKey: string,
    private readonly destinationIdentity: string,
    private readonly source: SnapshotJournalFieldArchiveBinding,
    private readonly request: Readonly<SnapshotJournalFieldUploadRequest>,
    private readonly bound: SnapshotJournalDestinationBinding,
    private readonly signal?: AbortSignal,
    private readonly preflight?: () => Promise<void>
  ) {}
  private static async request(
    rpc: SnapshotJournalFieldRpcCall,
    method: SnapshotJournalFieldRpcMethod,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    const params = [input]
    if (typeof input.identityKey !== 'string') throw new TypeError('Missing field destination identity')
    parseSnapshotJournalFieldRpcInput(method, params, input.identityKey)
    if (signal?.aborted) throw new SnapshotCancelledError('Field destination request cancelled before admission')
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason),
      timer = setTimeout(
        () => controller.abort(new WERR_INVALID_OPERATION('Field destination original I/O deadline reached')),
        limits.maxIoMs
      )
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await retrySnapshotArchiveOperation(() => awaitFromSync(() => rpc(method, params, controller.signal)))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  static async find(
    rpc: SnapshotJournalFieldRpcCall,
    identityKey: string,
    sourceStorageIdentity: string,
    signal?: AbortSignal
  ) {
    const input = await this.request(
      rpc,
      'findSnapshotJournalFieldUpload',
      { version: 1, identityKey, sourceStorageIdentity },
      signal
    )
    if (input === null) return undefined
    const value = snapshotJournalDataRecord(input, ['version', 'source', 'request']),
      source = parseSnapshotJournalFieldArchiveBinding(value.source),
      request = parseSnapshotJournalFieldUploadRequest(value.request)
    if (
      value.version !== 1 ||
      source.user.identityKey !== identityKey ||
      source.sourceStorage.storageIdentityKey !== sourceStorageIdentity ||
      request.sourceDigest !== snapshotJournalFieldUploadSourceDigest(source)
    )
      throw new TypeError('Discovered field upload changed original profile/source')
    return { version: 1 as const, source, request }
  }
  get isUploadReady(): boolean {
    return this.ready
  }

  static observe(
    rpc: SnapshotJournalFieldRpcCall,
    identityKey: string,
    sourceStorageIdentity: string,
    destinationIdentity: string
  ) {
    return mapAwaitFromSync(
      () =>
        this.request(rpc, 'getSnapshotJournalFieldStatus', {
          version: 1,
          identityKey,
          sourceStorageIdentity
        }),
      value => {
        if (value === null) return undefined
        return this.fieldStatus(value, identityKey, sourceStorageIdentity, destinationIdentity)
      }
    )
  }
  private static fieldStatus(value: unknown, identityKey: string, sourceIdentity: string, destinationIdentity: string) {
    const status = parseSnapshotJournalDataStatus(
      value,
      identityKey,
      sourceIdentity,
      destinationIdentity,
      'wallet-journal-fields/1'
    )
    if (status.binding.fieldEncoding !== 'wallet-journal-fields/1')
      throw new TypeError('Target did not return an actual field window')
    return status
  }
  static contentReceipt(
    rpc: SnapshotJournalFieldRpcCall,
    identityKey: string,
    sourceStorageIdentity: string,
    destinationIdentity: string,
    revision?: SnapshotSyncContentRevision
  ) {
    return mapAwaitFromSync(
      () =>
        this.request(
          rpc,
          revision === undefined
            ? 'getSnapshotJournalFieldContentReceipt'
            : 'confirmSnapshotJournalFieldContentReceipt',
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
          receipt.destinationStorageIdentity !== destinationIdentity
        )
          throw new TypeError('Field content receipt changed its authenticated endpoint/profile')
        return receipt
      }
    )
  }
  static async open(
    rpc: SnapshotJournalFieldRpcCall,
    identityKey: string,
    destinationIdentity: string,
    input: SnapshotJournalFieldArchiveBinding,
    signal?: AbortSignal,
    inputRequest?: SnapshotJournalFieldUploadRequest,
    preflight?: () => Promise<void>
  ) {
    const source = parseSnapshotJournalFieldArchiveBinding(input)
    if (source.user.identityKey !== identityKey) throw new TypeError('Field source profile differs')
    await preflight?.()
    let ready = false,
      request: Readonly<SnapshotJournalFieldUploadRequest>
    if (inputRequest === undefined) {
      const offered = await this.request(
          rpc,
          'offerSnapshotJournalFieldUpload',
          { version: 1, identityKey, source },
          signal
        ),
        outcome =
          offered !== null && typeof offered === 'object'
            ? Object.getOwnPropertyDescriptor(offered, 'outcome')?.value
            : undefined,
        row = snapshotJournalDataRecord(
          offered,
          outcome === 'offered' ? ['version', 'outcome', 'serverTime', 'request'] : ['version', 'outcome']
        )
      if (row.version !== 1) throw new TypeError('Invalid field upload offer')
      if (row.outcome === 'resource-limited') return undefined
      if (row.outcome !== 'offered' || typeof row.serverTime !== 'number')
        throw new TypeError('Invalid field upload offer')
      request = parseSnapshotJournalFieldUploadRequest(row.request, row.serverTime)
      if (
        request.sourceDigest !== snapshotJournalFieldUploadSourceDigest(source) ||
        request.notAfter > source.journal.receipt.expiresAt
      )
        throw new TypeError('Field upload offer changed original source or expiry')
    } else {
      request = parseSnapshotJournalFieldUploadRequest(inputRequest)
      if (
        request.sourceDigest !== snapshotJournalFieldUploadSourceDigest(source) ||
        request.notAfter > source.journal.receipt.expiresAt
      )
        throw new TypeError('Field upload recovery changed original source or expiry')
      const actual = validateSnapshotArchiveRequestReceipt(
        await this.request(
          rpc,
          'getSnapshotJournalFieldUploadStatus',
          { version: 1, identityKey, source, request },
          signal
        ),
        request
      )
      if (actual.state !== 'ready' && actual.state !== 'building')
        throw new WERR_INVALID_OPERATION('Field recovery requires its actual READY or building upload')
      ready = actual.state === 'ready'
    }
    const cleanup = async () => {
      if ((await this.request(rpc, 'cancelSnapshotJournalFieldUpload', { version: 1, identityKey, request })) !== true)
        throw new TypeError('Field upload cleanup was not acknowledged')
    }
    try {
      const value = await this.request(
        rpc,
        inputRequest === undefined ? 'beginSnapshotJournalFieldUpload' : 'resumeSnapshotJournalFieldUpload',
        { version: 1, identityKey, source, request },
        signal
      )
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'outcome')) {
        const refusal = snapshotJournalDataRecord(value, ['version', 'outcome'])
        if (refusal.version !== 1 || refusal.outcome !== 'bootstrap-required')
          throw new TypeError('Invalid field admission refusal')
        throw new SnapshotJournalDataBootstrapRequiredError()
      }
      const actual = this.fieldStatus(value, identityKey, source.sourceStorage.storageIdentityKey, destinationIdentity)
      if (
        JSON.stringify(actual.binding.source) !== JSON.stringify(source.journal.source) ||
        JSON.stringify(actual.binding.receipt) !== JSON.stringify(source.journal.receipt) ||
        actual.binding.low !== source.journal.low ||
        (actual.binding.bootstrap === true) !== source.journal.bootstrap
      )
        throw new TypeError('Field destination changed original source admission')
      const destination = new RemoteSnapshotJournalFieldDestination(
        rpc,
        identityKey,
        destinationIdentity,
        source,
        request,
        actual.binding,
        signal,
        preflight
      )
      void destination.closed.catch(() => undefined)
      destination.ready = ready
      return destination
    } catch (cause) {
      try {
        await cleanup()
      } catch (failure) {
        throw new RemoteSnapshotSyncTransferCleanupError(cause, failure, cleanup)
      }
      throw cause
    }
  }
  get uploadResume(): SnapshotJournalFieldUploadResume {
    return {
      version: 1,
      source: parseSnapshotJournalFieldArchiveBinding(JSON.parse(JSON.stringify(this.source))),
      request: parseSnapshotJournalFieldUploadRequest(JSON.parse(JSON.stringify(this.request)))
    }
  }
  static async resume(
    rpc: SnapshotJournalFieldRpcCall,
    identityKey: string,
    destinationIdentity: string,
    input: SnapshotJournalFieldUploadResume,
    signal?: AbortSignal,
    preflight?: () => Promise<void>
  ) {
    const value = snapshotJournalDataRecord(input, ['version', 'source', 'request'])
    if (value.version !== 1) throw new TypeError('Invalid field upload recovery version')
    const destination = await this.open(
      rpc,
      identityKey,
      destinationIdentity,
      parseSnapshotJournalFieldArchiveBinding(value.source),
      signal,
      parseSnapshotJournalFieldUploadRequest(value.request),
      preflight
    )
    if (destination === undefined) throw new WERR_INVALID_OPERATION('Actual uploaded field recovery is unavailable')
    return destination
  }
  /** Continue the server's original immutable READY bytes after a client/server
   * restart. No archive-shaped DATA or SQL source fence is manufactured. */
  async *reconcileUploaded(
    options: SnapshotJournalReconciliationOptions = {}
  ): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
    if (!this.ready) throw new WERR_INVALID_OPERATION('Uploaded field recovery has no actual READY artifact')
    return yield* runSnapshotJournalReconciliation(
      this,
      () =>
        promiseFromSync(() => ({
          status: () => this.status(),
          intake: expected =>
            this.exclusive(async () =>
              this.statusValue(
                await this.call('stageSnapshotJournalFieldFrame', {
                  checkpoint: parseSnapshotJournalDataCheckpoint(expected)
                })
              )
            ),
          promote: expected =>
            this.exclusive(async () =>
              this.statusValue(
                await this.call('promoteSnapshotJournalFields', {
                  checkpoint: parseSnapshotJournalDataCheckpoint(expected)
                })
              )
            )
        })),
      { ...options, signal: options.signal ?? this.signal }
    )
  }
  private async call(method: SnapshotJournalFieldRpcMethod, fields: Record<string, unknown> = {}, cleanup = false) {
    if (!cleanup) await this.preflight?.()
    return RemoteSnapshotJournalFieldDestination.request(
      this.rpc,
      method,
      { version: 1, identityKey: this.identityKey, source: this.source, request: this.request, ...fields },
      cleanup ? undefined : this.signal
    )
  }
  private statusValue(value: unknown) {
    const status = RemoteSnapshotJournalFieldDestination.fieldStatus(
      value,
      this.identityKey,
      this.source.sourceStorage.storageIdentityKey,
      this.destinationIdentity
    )
    if (JSON.stringify(status.binding) !== JSON.stringify(this.bound))
      throw new WERR_INVALID_OPERATION('Actual remote field window was replaced')
    return status
  }
  private async exclusive<T>(work: () => Promise<T>) {
    if (this.pending !== undefined || this.closing !== undefined)
      throw new WERR_INVALID_OPERATION('Field destination is busy or closing')
    const pending = Promise.resolve().then(work)
    this.pending = pending
    try {
      return await pending
    } finally {
      this.pending = undefined
    }
  }
  status(): Promise<SnapshotJournalDataStatus> {
    return awaitFromSync(() => {
      return this.exclusive(async () =>
        this.statusValue(
          await RemoteSnapshotJournalFieldDestination.request(this.rpc, 'getSnapshotJournalFieldStatus', {
            version: 1,
            identityKey: this.identityKey,
            sourceStorageIdentity: this.source.sourceStorage.storageIdentityKey
          })
        )
      )
    })
  }
  private async packet(sequence: number, streamIndex: number, bytes: Uint8Array) {
    if (bytes.length <= limits.inlinePacketBytes) {
      if ((await this.call('appendSnapshotJournalFieldPacket', { sequence, streamIndex, packet: bytes })) !== true)
        throw new TypeError('Field packet was not durably appended')
      return
    }
    const digest = syncTransferDigest(bytes)
    let transferId: string | undefined, failure: { cause: unknown } | undefined
    const cleanup = async () => {
      if (
        transferId !== undefined &&
        (await RemoteSnapshotJournalFieldDestination.request(this.rpc, 'releaseSnapshotJournalFieldTransfer', {
          version: 1,
          identityKey: this.identityKey,
          transferId
        })) !== true
      )
        throw new TypeError('Field packet transfer cleanup failed')
    }
    try {
      const row = snapshotJournalDataRecord(
          await this.call('beginSnapshotJournalFieldTransfer', {
            sequence,
            streamIndex,
            digest,
            totalBytes: bytes.length
          }),
          ['transferId', 'digest', 'totalBytes', 'partBytes', 'expiresAt', 'receivedBytes']
        ),
        manifest = validateSyncTransferManifest(row as unknown as SyncTransferManifest, {
          version: 1,
          maxBytes: limits.maxPacketBytes,
          partBytes: limits.partBytes
        }),
        received = row.receivedBytes
      transferId = snapshotJournalDataDigest(row.transferId)
      if (
        manifest.digest !== digest ||
        manifest.totalBytes !== bytes.length ||
        manifest.expiresAt > this.request.notAfter ||
        typeof received !== 'number' ||
        !Number.isSafeInteger(received) ||
        received < 0 ||
        received > bytes.length ||
        (received !== bytes.length && received % manifest.partBytes !== 0)
      )
        throw new TypeError('Field transfer changed original bounds')
      for (let offset = received; offset < bytes.length; offset += manifest.partBytes) {
        const part = bytes.subarray(offset, Math.min(offset + manifest.partBytes, bytes.length)),
          accepted = await this.call('writeSnapshotJournalFieldTransferPart', {
            sequence,
            streamIndex,
            transferId,
            offset,
            bytes: part
          })
        if (
          typeof accepted !== 'number' ||
          accepted < offset + part.length ||
          accepted > bytes.length ||
          (accepted !== bytes.length && accepted % manifest.partBytes !== 0)
        )
          throw new TypeError('Field transfer part ACK changed')
      }
      if ((await this.call('appendSnapshotJournalFieldTransfer', { sequence, streamIndex, transferId })) !== true)
        throw new TypeError('Field transfer was not durably appended')
    } catch (cause) {
      failure = { cause }
    }
    try {
      await cleanup()
    } catch (cause) {
      throw new RemoteSnapshotSyncTransferCleanupError(failure?.cause, cause, cleanup)
    }
    if (failure !== undefined) throw failure.cause
  }
  private async upload(archive: RemoteSnapshotJournalFieldArchive) {
    assertRemoteSnapshotJournalFieldArchive(archive)
    if (snapshotJournalFieldUploadSourceDigest(archive.manifest.binding) !== this.request.sourceDigest)
      throw new WERR_INVALID_OPERATION('Actual field source archive changed')
    if (this.ready && this.uploaded === undefined) {
      this.uploaded = archive
      return
    }
    if (this.uploaded !== undefined) {
      if (this.uploaded !== archive)
        throw new WERR_INVALID_OPERATION('Field upload belongs to another actual source owner')
      return
    }
    const seen = new Map<string, number>()
    let sequence = 0,
      streamIndex = 0
    const append = async (bytes: Uint8Array) => {
      try {
        if (sequence >= 4096) throw new SnapshotResourceLimitError('Field upload packet bound reached')
        await this.packet(sequence, streamIndex, bytes)
        sequence++
      } finally {
        bytes.fill(0)
      }
    }
    for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
      const stream = snapshotJournalArchiveStreams[streamIndex]
      if (stream === undefined) throw new TypeError('Field upload has extra streams')
      const context = { stream: stream.stream, tableId: stream.tableId },
        frame = await archive.readFrame(ordinal, (digest, index, identities) =>
          awaitVoidFromSync(() =>
            append(
              encodeSnapshotJournalFieldArchiveIdentities(
                context,
                digest,
                index,
                identities,
                this.source.journal.receipt.highWater
              )
            )
          )
        )
      if (frame.stream !== stream.stream || frame.tableId !== stream.tableId)
        throw new TypeError('Actual field frame stream differs')
      const page = frame.page
      for (let index = 0; index < page.changes.length; index++) {
        const change = page.changes[index]
        if (!change.present) continue
        for (const [field, descriptor] of Object.entries(change.fields)) {
          const prior = seen.get(descriptor.sha256)
          if (prior !== undefined) {
            if (prior !== descriptor.bytes) throw new TypeError('Field hash has mixed lengths')
            // Even reused content checks the actual original source lease/EOF.
            const eof = await archive.readFieldExtent(frame, index, field, descriptor.bytes, 0)
            if (eof.length !== 0) throw new TypeError('Field source EOF differs')
            continue
          }
          if (seen.size >= 4096) throw new SnapshotResourceLimitError('Field upload content index bound reached')
          const hash = new SHA256()
          let offset = 0
          do {
            const length = Math.min(65536, descriptor.bytes - offset),
              bytes = await archive.readFieldExtent(frame, index, field, offset, length)
            try {
              if (bytes.length !== length) throw new TypeError('Actual field upload extent differs')
              hash.update(bytes)
              await append(
                encodeSnapshotJournalFieldArchiveContent(
                  context,
                  frame.frameDigest,
                  index,
                  field,
                  descriptor,
                  offset,
                  bytes
                )
              )
              offset += length
            } finally {
              bytes.fill(0)
            }
          } while (offset < descriptor.bytes)
          const eof = await archive.readFieldExtent(frame, index, field, descriptor.bytes, 0)
          if (eof.length !== 0 || hash.digestHex() !== descriptor.sha256)
            throw new TypeError('Actual field upload SHA/EOF differs')
          seen.set(descriptor.sha256, descriptor.bytes)
        }
      }
      await append(encodeSnapshotJournalFieldArchiveFrame(context, page))
      if (page.complete) streamIndex++
    }
    if (streamIndex !== snapshotJournalArchiveStreams.length)
      throw new TypeError('Field upload stream set is incomplete')
    const sealed = snapshotJournalDataRecord(await this.call('sealSnapshotJournalFieldUpload'), [
      'version',
      'archiveId',
      'digest',
      'expiresAt'
    ])
    if (sealed.version !== 1 || sealed.expiresAt !== this.request.notAfter)
      throw new TypeError('Field upload seal changed original expiry')
    snapshotJournalDataDigest(sealed.archiveId)
    snapshotJournalDataDigest(sealed.digest)
    this.uploaded = archive
    this.ready = true
  }
  stageArchiveFrame(input: SnapshotJournalDestinationCheckpoint, archive: RemoteSnapshotJournalFieldArchive) {
    return awaitFromSync(() => {
      const checkpoint = parseSnapshotJournalDataCheckpoint(input)
      return this.exclusive(async () => {
        await this.upload(archive)
        return this.statusValue(await this.call('stageSnapshotJournalFieldFrame', { checkpoint }))
      })
    })
  }
  promote(input: SnapshotJournalDestinationCheckpoint, archive: RemoteSnapshotJournalFieldArchive) {
    return awaitFromSync(() => {
      const checkpoint = parseSnapshotJournalDataCheckpoint(input)
      return this.exclusive(async () => {
        await this.upload(archive)
        return this.statusValue(await this.call('promoteSnapshotJournalFields', { checkpoint }))
      })
    })
  }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const pending = this.pending
    this.closing = Promise.resolve().then(async () => {
      await pending?.catch(() => undefined)
      const cleanup = async () => {
        if (
          (await RemoteSnapshotJournalFieldDestination.request(this.rpc, 'cancelSnapshotJournalFieldUpload', {
            version: 1,
            identityKey: this.identityKey,
            request: this.request
          })) !== true
        )
          throw new TypeError('Field upload physical cleanup failed')
      }
      try {
        await cleanup()
      } catch (cause) {
        throw new RemoteSnapshotSyncTransferCleanupError(undefined, cause, cleanup)
      }
    })
    void this.closing.then(this.resolveClosed, this.rejectClosed)
    return this.closing
  }
}
