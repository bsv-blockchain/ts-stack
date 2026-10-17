import {
  encodeSyncTransfer,
  syncTransferDigest,
  validateSyncTransferManifest,
  type SyncTransferManifest
} from '../remoting/SyncTransfer'
import {
  snapshotSyncTables,
  type SnapshotSyncStorage,
  type SnapshotSyncSource,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncTable,
  type SnapshotSyncCommit
} from './SnapshotSync'
import type { WalletReadSnapshot, WalletReadSnapshotOptions, WalletSnapshotPage } from './WalletReadSnapshot'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { detachSnapshotSyncPage } from './SnapshotSyncRows'
import {
  parseRemoteSnapshotSyncCheckpoint,
  parseRemoteSnapshotSyncCommit,
  parseRemoteSnapshotSyncPage,
  remoteSnapshotSyncCapabilities,
  remoteSnapshotSyncFrameBytes,
  remoteSnapshotSyncInlineFrameBytes,
  remoteSnapshotSyncPartBytes,
  type RemoteSnapshotSyncMethod
} from './RemoteSnapshotSyncProtocol'

type Rpc = (method: RemoteSnapshotSyncMethod, params: unknown[], signal: AbortSignal) => Promise<unknown>
interface Session {
  readonly expiresAt: number
  readonly deadline: number
  readonly sourceUserId: number
  readonly snapshotId: string
  readonly scope: Readonly<{
    identityKey: string
    sourceStorageIdentityKey: string
    destinationStorageIdentityKey: string
  }>
}
interface Peer {
  readonly storageIdentityKey: string
  readonly supportsDestination: boolean
}

/** Retains the concrete authenticated cleanup of one original SQL transfer.
 * A failed release is not cleanup; concurrent retries share the same attempt. */
export class RemoteSnapshotSyncTransferCleanupError extends Error {
  private pending?: Promise<void>
  private complete = false
  constructor(
    override readonly cause: unknown,
    readonly cleanupError: unknown,
    private readonly cleanup: () => Promise<void>
  ) {
    super('Remote snapshot staged page retains its original transfer cleanup')
    this.name = 'RemoteSnapshotSyncTransferCleanupError'
  }
  get cleaned(): boolean {
    return this.complete
  }
  retryCleanup(): Promise<void> {
    if (this.complete) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    this.pending = Promise.resolve()
      .then(this.cleanup)
      .then(() => {
        this.complete = true
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
}

/** One bounded page in flight, with no client-held merge writer during HTTP.
 * Neither an HTTP success nor a sender progress log is a durable checkpoint;
 * exact server ACK validation and destination observation remain mandatory. */
export class RemoteSnapshotSyncDestination implements SnapshotSyncStorage {
  readonly commitOutsideManager = true as const
  readonly fallbackOnResourceError = false
  readonly pageLimits = Object.freeze({
    maxRows: remoteSnapshotSyncCapabilities.maxRows,
    maxBytes: remoteSnapshotSyncCapabilities.maxBytes
  })
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly rpc: Rpc,
    private readonly peer: () => Promise<Peer>,
    readonly openSource: (
      identityKey: string,
      options?: WalletReadSnapshotOptions
    ) => Promise<WalletReadSnapshot | undefined>
  ) {}

  async supportsDestination(): Promise<boolean> {
    return (await this.peer()).supportsDestination
  }

  private async request(
    method: RemoteSnapshotSyncMethod,
    params: unknown[],
    session?: Pick<Session, 'deadline' | 'expiresAt'>
  ): Promise<unknown> {
    const end = Math.min(performance.now() + remoteSnapshotSyncCapabilities.maxIoMs, session?.deadline ?? Infinity)
    if ((session !== undefined && Date.now() >= session.expiresAt) || performance.now() >= end)
      throw new WERR_INVALID_OPERATION('Remote snapshot original source deadline reached')
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new WERR_INVALID_OPERATION('Remote snapshot I/O deadline reached')),
      Math.max(1, Math.ceil(end - performance.now()))
    )
    try {
      // Await the actual transport promise even after cancellation; a timer is
      // not proof that owned authentication/HTTP work has physically drained.
      const result = await this.rpc(method, params, controller.signal)
      if (
        controller.signal.aborted ||
        performance.now() >= end ||
        (session !== undefined && Date.now() >= session.expiresAt)
      )
        throw new WERR_INVALID_OPERATION('Remote snapshot I/O or original source deadline reached')
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async begin(source: SnapshotSyncSource, activeStorage: string | undefined): Promise<SnapshotSyncCheckpoint> {
    // Detach supplied source DATA before the first await. Reader-only peers
    // also reject absent DATA with the existing negotiation error.
    const selected =
      source == null
        ? undefined
        : {
            version: source.version,
            snapshotId: source.snapshotId,
            sourceStorage: {
              ...source.sourceStorage,
              created_at: new Date(source.sourceStorage.created_at),
              updated_at: new Date(source.sourceStorage.updated_at)
            },
            user: {
              ...source.user,
              created_at: new Date(source.user.created_at),
              updated_at: new Date(source.user.updated_at)
            },
            expiresAt: source.expiresAt
          }
    const session =
      selected === undefined
        ? undefined
        : {
            expiresAt: selected.expiresAt,
            deadline: performance.now() + Math.max(0, selected.expiresAt - Date.now()),
            sourceUserId: selected.user.userId
          }
    for (const [key, value] of this.sessions)
      if (Date.now() >= value.expiresAt || performance.now() >= value.deadline) this.sessions.delete(key)
    if (this.sessions.size >= 8) throw new WERR_INVALID_OPERATION('Remote snapshot local session bound reached')
    const peer = await this.peer()
    if (!peer.supportsDestination) throw new WERR_INVALID_OPERATION('Remote snapshot destination is not negotiated')
    if (selected === undefined || session === undefined)
      throw new WERR_INVALID_OPERATION('Remote snapshot begin requires its original source')
    const result = await this.request('beginSnapshotSync', [selected, activeStorage], session)
    const checkpoint = parseRemoteSnapshotSyncCheckpoint(result, {
      identityKey: selected.user.identityKey,
      sourceStorageIdentityKey: selected.sourceStorage.storageIdentityKey,
      destinationStorageIdentityKey: peer.storageIdentityKey
    })
    if (checkpoint.snapshotId !== selected.snapshotId)
      throw new WERR_INVALID_OPERATION('Remote snapshot begin changed its source view')
    this.sessions.set(
      checkpoint.sessionId,
      Object.freeze({
        ...session,
        snapshotId: selected.snapshotId,
        scope: Object.freeze({
          identityKey: selected.user.identityKey,
          sourceStorageIdentityKey: selected.sourceStorage.storageIdentityKey,
          destinationStorageIdentityKey: peer.storageIdentityKey
        })
      })
    )
    return checkpoint
  }

  async checkpoint(identityKey: string, sourceStorageIdentityKey: string): Promise<SnapshotSyncCheckpoint | undefined> {
    const peer = await this.peer()
    if (!peer.supportsDestination) throw new WERR_INVALID_OPERATION('Remote snapshot destination is not negotiated')
    const result = await this.request('getSnapshotSyncCheckpoint', [identityKey, sourceStorageIdentityKey])
    return result === null
      ? undefined
      : parseRemoteSnapshotSyncCheckpoint(result, {
          identityKey,
          sourceStorageIdentityKey,
          destinationStorageIdentityKey: peer.storageIdentityKey
        })
  }

  async prepare(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ): Promise<
    () => Promise<{
      checkpoint: SnapshotSyncCheckpoint
      inserts: number
      updates: number
    }>
  > {
    const session = checkpoint == null ? undefined : this.sessions.get(checkpoint.sessionId)
    if (session === undefined) {
      const peer = await this.peer()
      if (!peer.supportsDestination) throw new WERR_INVALID_OPERATION('Remote snapshot destination is not negotiated')
      throw new WERR_INVALID_OPERATION('Remote snapshot page requires its original negotiated session')
    }
    if (checkpoint.done || snapshotSyncTables[checkpoint.tableIndex] === undefined)
      throw new WERR_INVALID_OPERATION('Remote snapshot page requires its original negotiated session')
    // Encoding detaches the whole bounded page before any asynchronous work;
    // raw binary extents never expand through number[] JSON serialization.
    const expected = parseRemoteSnapshotSyncCheckpoint(checkpoint, session.scope)
    if (expected.snapshotId !== session.snapshotId)
      throw new WERR_INVALID_OPERATION('Remote snapshot page changed its original source view')
    if (
      !Array.isArray(page.rows) ||
      page.rows.length > this.pageLimits.maxRows ||
      page.payloadBytes > this.pageLimits.maxBytes
    )
      throw new RangeError('Remote snapshot page exceeds its original allocation bound')
    detachSnapshotSyncPage(expected, page)
    const inline = encodeSyncTransfer(page)
    const bytes =
      inline.length <= remoteSnapshotSyncInlineFrameBytes ? inline : encodeSyncTransfer({ checkpoint: expected, page })
    if (bytes.length > remoteSnapshotSyncFrameBytes)
      throw new RangeError('Remote snapshot page exceeds its frame bound')
    parseRemoteSnapshotSyncPage(inline, expected, session.sourceUserId)
    let consumed = false
    return async () => {
      if (consumed)
        throw new WERR_INVALID_OPERATION('Remote snapshot page already consumed; observe its durable checkpoint')
      consumed = true
      const io = {
        expiresAt: session.expiresAt,
        deadline: Math.min(session.deadline, performance.now() + remoteSnapshotSyncCapabilities.maxIoMs)
      }
      if (inline.length <= remoteSnapshotSyncInlineFrameBytes)
        return parseRemoteSnapshotSyncCommit(
          await this.request('commitSnapshotSyncPage', [expected, bytes], io),
          expected
        )
      const digest = syncTransferDigest(bytes)
      let transferId: string | undefined,
        result: unknown,
        failure: unknown,
        failed = false
      try {
        const manifest = validateSyncTransferManifest(
          (await this.request(
            'beginSnapshotSyncPageTransfer',
            [expected, { digest, totalBytes: bytes.length }],
            io
          )) as SyncTransferManifest & { receivedBytes: number },
          { version: 1, maxBytes: remoteSnapshotSyncFrameBytes, partBytes: remoteSnapshotSyncPartBytes }
        ) as SyncTransferManifest & { receivedBytes: number }
        transferId = manifest.transferId
        if (
          manifest.digest !== digest ||
          manifest.totalBytes !== bytes.length ||
          manifest.expiresAt > session.expiresAt ||
          !Number.isSafeInteger(manifest.receivedBytes) ||
          manifest.receivedBytes < 0 ||
          manifest.receivedBytes > bytes.length ||
          (manifest.receivedBytes !== bytes.length && manifest.receivedBytes % manifest.partBytes !== 0)
        )
          throw new WERR_INVALID_OPERATION('Remote snapshot staged page changed its original manifest')
        for (let offset = manifest.receivedBytes; offset < bytes.length; offset += manifest.partBytes) {
          const part = bytes.subarray(offset, Math.min(offset + manifest.partBytes, bytes.length)),
            next = await this.request(
              'writeSnapshotSyncPageTransferPart',
              [expected, { transferId, offset, bytes: part }],
              io
            )
          if (next !== offset + part.length)
            throw new WERR_INVALID_OPERATION('Remote snapshot staged page acknowledgement changed')
        }
        result = parseRemoteSnapshotSyncCommit(
          await this.request('commitSnapshotSyncPageTransfer', [expected, { transferId }], io),
          expected
        )
      } catch (cause) {
        failed = true
        failure = cause
      }
      const cleanup = async (): Promise<void> => {
        if (
          transferId !== undefined &&
          (await this.request('releaseSnapshotSyncPageTransfer', [expected, { transferId }])) !== true
        )
          throw new WERR_INVALID_OPERATION('Remote snapshot staged page cleanup was not confirmed')
      }
      try {
        await cleanup()
      } catch (cleanupError) {
        throw new RemoteSnapshotSyncTransferCleanupError(failed ? failure : undefined, cleanupError, cleanup)
      }
      if (failed) throw failure
      return result as SnapshotSyncCommit
    }
  }
}
