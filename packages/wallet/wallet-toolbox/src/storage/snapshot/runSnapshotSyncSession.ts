import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { parseSnapshotSyncContentRevision } from './SnapshotSyncContentRevision'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { SnapshotWorkingAllocationLimitError } from './SnapshotWorkingAllocationLimitError'
import type { RequestSyncChunkArgs } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { SyncPageBudget } from '../sync/SyncPageBudget'
import type { SyncSessionOptions, SyncSessionProgress, SyncSessionResult } from '../sync/syncSession'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncStorage,
  type SnapshotSyncFieldPreparation,
  type SnapshotSyncTable
} from './SnapshotSync'
import type { WalletReadSnapshot, WalletSnapshotCursor, WalletSnapshotFieldMetadataPage } from './WalletReadSnapshot'
import { copySnapshotCursor, sameSnapshotArchivePosition } from './SnapshotCursor'
import { commitSyncAdmission } from '../sync/commitSyncAdmission'

interface SnapshotSession {
  view: WalletReadSnapshot
  destination: SnapshotSyncStorage
  activeStorage: string
  /** Check primary generation and cancellation inside background write admission. */
  commit: <T>(operation: () => Promise<T>) => Promise<T>
}

function copyCheckpoint(value: SnapshotSyncCheckpoint): SnapshotSyncCheckpoint
function copyCheckpoint(value: SnapshotSyncCheckpoint | undefined): SnapshotSyncCheckpoint | undefined
function copyCheckpoint(value: SnapshotSyncCheckpoint | undefined): SnapshotSyncCheckpoint | undefined {
  return value === undefined ? undefined : { ...value, cursor: copySnapshotCursor(value.cursor) }
}

type NotifyProgress = (state: SyncSessionProgress['state'], timing?: Partial<SyncSessionProgress>) => void

function validateAcknowledgement(
  previous: SnapshotSyncCheckpoint,
  page: { done: boolean; cursor?: WalletSnapshotCursor },
  next: SnapshotSyncCheckpoint
): void {
  const tableIndex = previous.tableIndex + Number(page.done)
  const expected = {
    ...previous,
    sequence: previous.sequence + 1,
    tableIndex,
    done: tableIndex === snapshotSyncTables.length
  }
  const bindings = [
    'version',
    'sessionId',
    'identityKey',
    'sourceStorageIdentityKey',
    'destinationStorageIdentityKey',
    'snapshotId',
    'sequence',
    'tableIndex',
    'done'
  ] as const
  const cursor = page.done ? undefined : page.cursor
  if (
    bindings.some(key => next[key] !== expected[key]) ||
    next.cursor?.version !== cursor?.version ||
    next.cursor?.snapshotId !== cursor?.snapshotId ||
    next.cursor?.table !== cursor?.table ||
    JSON.stringify(next.cursor?.after) !== JSON.stringify(cursor?.after) ||
    !sameSnapshotArchivePosition(next.cursor?.archivePosition, cursor?.archivePosition)
  ) {
    throw new WERR_INVALID_OPERATION(
      'Snapshot destination acknowledgement does not match the committed page; reload its durable checkpoint'
    )
  }
}

async function preparePage(
  session: SnapshotSession,
  checkpoint: SnapshotSyncCheckpoint,
  limits: { maxRows: number; maxBytes: number },
  notify: NotifyProgress,
  cancelled: () => boolean,
  signal?: AbortSignal
) {
  notify('reading')
  if (cancelled()) return undefined
  const readAt = Date.now()
  const table = snapshotSyncTables[checkpoint.tableIndex],
    fieldReader = session.view.fieldReader,
    prepareFields = session.destination.prepareFields
  const fieldDestination =
    fieldReader !== undefined &&
    prepareFields !== undefined &&
    (session.destination.supportsFieldDestination === undefined ||
      (await session.destination.supportsFieldDestination()))
  if (cancelled()) return undefined
  if (fieldReader !== undefined && prepareFields !== undefined && fieldDestination) {
    const originalExtentBytes = fieldReader.extentBytesRead
    if (originalExtentBytes !== undefined && (!Number.isSafeInteger(originalExtentBytes) || originalExtentBytes < 0))
      throw new WERR_INVALID_OPERATION('Snapshot field read telemetry differs from its original integer range')
    const original = session.destination.fieldPageLimits
    if (
      original !== undefined &&
      (!Number.isSafeInteger(original.maxRows) ||
        original.maxRows < 1 ||
        original.maxRows > 1000 ||
        !Number.isSafeInteger(original.maxBytes) ||
        original.maxBytes < 1 ||
        original.maxBytes > 10000000)
    )
      throw new WERR_INVALID_OPERATION('Snapshot destination field limits differ from the original request')
    let admitted =
      original === undefined
        ? { ...limits }
        : {
            maxRows: Math.min(limits.maxRows, original.maxRows),
            maxBytes: Math.min(limits.maxBytes, original.maxBytes)
          }
    if (
      !Number.isSafeInteger(admitted.maxRows) ||
      admitted.maxRows < 1 ||
      admitted.maxRows > limits.maxRows ||
      !Number.isSafeInteger(admitted.maxBytes) ||
      admitted.maxBytes < 1 ||
      admitted.maxBytes > limits.maxBytes
    )
      throw new WERR_INVALID_OPERATION('Snapshot destination field limits differ from the original request')
    let page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
      prepared: SnapshotSyncFieldPreparation,
      readMs = 0,
      prepareMs = 0
    while (true) {
      if (cancelled()) return undefined
      const attemptReadAt = Date.now()
      page = await fieldReader.readMetadataPage(table, checkpoint.cursor, admitted)
      readMs += Date.now() - attemptReadAt
      if (cancelled()) return undefined
      notify('preparing', { readMs, prepareMs })
      if (cancelled()) return undefined
      const prepareAt = Date.now()
      try {
        prepared = await prepareFields.call(session.destination, checkpoint, page, session.view, signal)
        prepareMs += Date.now() - prepareAt
        break
      } catch (cause) {
        prepareMs += Date.now() - prepareAt
        // The provider contract drains a failed preparation before rejection.
        // Retry only this typed pre-reservation refusal, on the same original
        // source/checkpoint/deadline. No effects or durable ACK have occurred.
        // Cleanup/expiry/storage quota/malformed-input errors stay terminal.
        if (
          !(cause instanceof SnapshotWorkingAllocationLimitError) ||
          page.rows.length <= 1 ||
          !session.view.isOpen ||
          Date.now() >= session.view.expiresAt ||
          signal?.aborted === true
        )
          throw cause
        const maxRows = Math.min(admitted.maxRows - 1, Math.floor(page.rows.length / 2))
        if (maxRows < 1) throw cause
        admitted = { ...admitted, maxRows }
        notify('reading', { readMs, prepareMs })
      }
    }
    let stopped: boolean, fieldBytesRead: number | undefined
    try {
      const actual = fieldReader.extentBytesRead
      if (originalExtentBytes !== undefined) {
        if (actual === undefined || !Number.isSafeInteger(actual) || actual < originalExtentBytes)
          throw new WERR_INVALID_OPERATION('Snapshot field read telemetry changed during preparation')
        fieldBytesRead = actual - originalExtentBytes
      }
      stopped = cancelled()
    } catch (cause) {
      try {
        await prepared.close()
      } catch (error_) {
        throw new AggregateError([cause, error_], 'Snapshot field preparation and drainage failed', { cause })
      }
      throw cause
    }
    if (stopped) {
      await prepared.close()
      return undefined
    }
    return { page, apply: () => prepared.apply(), close: () => prepared.close(), readMs, prepareMs, fieldBytesRead }
  }
  const ceiling = session.destination.pageLimits
  if (
    ceiling !== undefined &&
    (!Number.isSafeInteger(ceiling.maxRows) ||
      ceiling.maxRows < 1 ||
      ceiling.maxRows > 1000 ||
      !Number.isSafeInteger(ceiling.maxBytes) ||
      ceiling.maxBytes < 1 ||
      ceiling.maxBytes > 10000000)
  )
    throw new WERR_INVALID_OPERATION('Snapshot destination row limits differ from the original request')
  const admitted =
    ceiling === undefined
      ? limits
      : { maxRows: Math.min(limits.maxRows, ceiling.maxRows), maxBytes: Math.min(limits.maxBytes, ceiling.maxBytes) }
  const page = await session.view.readPage(table, checkpoint.cursor, admitted)
  const readMs = Date.now() - readAt
  if (cancelled()) return undefined
  notify('preparing', { readMs })
  if (cancelled()) return undefined
  const prepareAt = Date.now()
  const apply = await session.destination.prepare(checkpoint, page)
  const prepareMs = Date.now() - prepareAt
  if (cancelled()) return undefined
  return { page, apply, close: undefined, readMs, prepareMs, fieldBytesRead: undefined }
}

function rejectClosedSnapshot(view: WalletReadSnapshot): Promise<never> {
  return mapAwaitFromSync(
    () => view.closed,
    () => {
      if (Date.now() >= view.expiresAt)
        throw new SnapshotResourceLimitError('Snapshot source expired before destination commit')
      throw new WERR_INVALID_OPERATION('Snapshot source closed before destination commit')
    }
  )
}

/** One packed page in flight. The caller owns source cleanup, including error/cancellation. */
export async function runSnapshotSyncSession(
  session: SnapshotSession,
  options: SyncSessionOptions
): Promise<SyncSessionResult> {
  const maxItems = options.maxItems ?? 1000
  const maxBytes = options.maxRoughSize ?? 262144
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 1000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 10000000
  ) {
    throw new WERR_INVALID_PARAMETER('limits', '1–1000 rows and 1–10000000 payload bytes')
  }
  const result: SyncSessionResult = { status: 'completed', mode: 'paged', pages: 0, inserts: 0, updates: 0 }
  const notify = (state: SyncSessionProgress['state'], timing: Partial<SyncSessionProgress> = {}): void => {
    options.onProgress?.({ ...result, ...timing, state, snapshotCheckpoint: copyCheckpoint(result.snapshotCheckpoint) })
  }
  const cancelled = (): boolean => {
    if (options.signal?.aborted !== true) return false
    result.status = 'cancelled'
    notify('cancelling')
    notify('cancelled')
    return true
  }
  if (cancelled()) return result
  const contentRevision =
    session.view.readContentRevision !== undefined &&
    session.destination.beginContent !== undefined &&
    session.destination.supportsContentDestination !== undefined &&
    (await session.destination.supportsContentDestination())
      ? parseSnapshotSyncContentRevision(await session.view.readContentRevision())
      : undefined
  if (cancelled()) return result
  const start = await commitSyncAdmission(
    session.commit,
    async () =>
      options.signal?.aborted === true
        ? undefined
        : contentRevision === undefined
          ? await session.destination.begin(session.view, session.activeStorage)
          : await session.destination.beginContent!(session.view, session.activeStorage, contentRevision),
    options.signal
  )
  if (start === undefined) {
    cancelled()
    return result
  }
  result.snapshotCheckpoint = start
  const budget = new SyncPageBudget()
  const args: RequestSyncChunkArgs = {
    identityKey: start.identityKey,
    fromStorageIdentityKey: start.sourceStorageIdentityKey,
    toStorageIdentityKey: start.destinationStorageIdentityKey,
    maxItems,
    maxRoughSize: maxBytes,
    offsets: []
  }
  while (!result.snapshotCheckpoint.done) {
    if (cancelled()) return result
    const checkpoint = result.snapshotCheckpoint
    const table = snapshotSyncTables[checkpoint.tableIndex]
    budget.beginTable(table)
    const prepared = await preparePage(
      session,
      checkpoint,
      { maxRows: budget.apply(args).maxItems, maxBytes },
      notify,
      cancelled,
      options.signal
    )
    if (prepared === undefined) return result
    const { page, apply, readMs, prepareMs, fieldBytesRead } = prepared
    let failure: { cause: unknown } | undefined
    let sourceClosed = false
    let commitCancelled = false
    try {
      notify('committing', { readMs, prepareMs })
      const queuedAt = Date.now()
      let commitAt = queuedAt
      const committed = await commitSyncAdmission(
        session.commit,
        async () => {
          if (options.signal?.aborted === true) return undefined
          if (!session.view.isOpen) return 'source-closed' as const
          commitAt = Date.now()
          return await apply()
        },
        options.signal
      )
      if (committed === 'source-closed') sourceClosed = true
      else {
        if (committed === undefined) {
          cancelled()
          commitCancelled = true
        } else {
          validateAcknowledgement(checkpoint, page, committed.checkpoint)
          const commitMs = Date.now() - commitAt
          result.pages++
          result.inserts += committed.inserts
          result.updates += committed.updates
          result.snapshotCheckpoint = copyCheckpoint(committed.checkpoint)
          budget.committedSnapshot(
            table,
            page.rows.length,
            readMs + prepareMs + commitMs,
            readMs + prepareMs,
            fieldBytesRead === undefined || fieldBytesRead === 0 ? page.payloadBytes : fieldBytesRead
          )
          notify('committed', { readMs, prepareMs, queueMs: commitAt - queuedAt, commitMs, fieldBytesRead })
        }
      }
    } catch (cause) {
      failure = { cause }
    }
    try {
      await prepared.close?.()
    } catch (error_) {
      if (failure !== undefined)
        throw new AggregateError([failure.cause, error_], 'Snapshot field commit and drainage failed', {
          cause: failure.cause
        })
      throw error_
    }
    if (failure !== undefined) throw failure.cause
    if (commitCancelled) return result
    // Drain prepared content before waiting for original source cleanup, which
    // may itself depend on the preparation releasing its owned allocations.
    if (sourceClosed) return await rejectClosedSnapshot(session.view)
    if (cancelled()) return result
  }
  notify('completed')
  return result
}
