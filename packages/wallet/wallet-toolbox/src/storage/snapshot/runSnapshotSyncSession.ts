import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { SyncPageBudget } from '../sync/SyncPageBudget'
import type { SyncSessionOptions, SyncSessionProgress, SyncSessionResult } from '../sync/syncSession'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncStorage } from './SnapshotSync'
import type { WalletReadSnapshot, WalletSnapshotCursor } from './WalletReadSnapshot'
import { copySnapshotCursor, sameSnapshotArchivePosition } from './SnapshotCursor'

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
  cancelled: () => boolean
) {
  notify('reading')
  if (cancelled()) return undefined
  const readAt = Date.now()
  const page = await session.view.readPage(snapshotSyncTables[checkpoint.tableIndex], checkpoint.cursor, limits)
  const readMs = Date.now() - readAt
  if (cancelled()) return undefined
  notify('preparing', { readMs })
  if (cancelled()) return undefined
  const prepareAt = Date.now()
  const apply = await session.destination.prepare(checkpoint, page)
  const prepareMs = Date.now() - prepareAt
  if (cancelled()) return undefined
  return { page, apply, readMs, prepareMs }
}

async function rejectClosedSnapshot(view: WalletReadSnapshot): Promise<never> {
  // Physical cleanup may need database I/O; await it after queue ownership
  // was released. Its actual expiry/cancellation/read error stays authoritative.
  await view.closed
  if (Date.now() >= view.expiresAt)
    throw new SnapshotResourceLimitError('Snapshot source expired before destination commit')
  throw new WERR_INVALID_OPERATION('Snapshot source closed before destination commit')
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
  const start = await session.commit(async () =>
    options.signal?.aborted === true ? undefined : await session.destination.begin(session.view, session.activeStorage)
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
      cancelled
    )
    if (prepared === undefined) return result
    const { page, apply, readMs, prepareMs } = prepared
    notify('committing', { readMs, prepareMs })
    const queuedAt = Date.now()
    let commitAt = queuedAt
    const committed = await session.commit(async () => {
      if (options.signal?.aborted === true) return undefined
      if (!session.view.isOpen) return 'source-closed' as const
      commitAt = Date.now()
      return await apply()
    })
    if (committed === 'source-closed') return await rejectClosedSnapshot(session.view)
    if (committed === undefined) {
      cancelled()
      return result
    }
    validateAcknowledgement(checkpoint, page, committed.checkpoint)
    const commitMs = Date.now() - commitAt
    result.pages++
    result.inserts += committed.inserts
    result.updates += committed.updates
    result.snapshotCheckpoint = copyCheckpoint(committed.checkpoint)
    budget.committed(
      {
        userIdentityKey: start.identityKey,
        fromStorageIdentityKey: start.sourceStorageIdentityKey,
        toStorageIdentityKey: start.destinationStorageIdentityKey,
        [table]: page.rows
      } as SyncChunk,
      readMs + prepareMs + commitMs,
      readMs + prepareMs,
      page.payloadBytes
    )
    notify('committed', { readMs, prepareMs, queueMs: commitAt - queuedAt, commitMs })
    if (cancelled()) return result
  }
  notify('completed')
  return result
}
