import type {
  ProcessSyncChunkResult,
  RequestSyncChunkArgs,
  SyncCheckpoint,
  SyncChunk,
  WalletStorageSync,
  WalletStorageSyncReader
} from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { SyncPageBudget } from './SyncPageBudget'
import { validateSyncCheckpoint } from './syncCheckpoint'
import { assertSyncProgress, throwSyncResultError } from './syncFailure'

export interface SyncSessionOptions {
  /** Cancellation waits for an in-flight commit acknowledgement; it never rolls back an acknowledged page. */
  signal?: AbortSignal
  /** Additional page ceilings; defaults are 1,000 rows and 262,144 rough encoded bytes. */
  maxItems?: number
  maxRoughSize?: number
  /** Called outside page ownership in paged mode. Checkpoints are independent copies. */
  onProgress?: (progress: SyncSessionProgress) => void
}

export interface SyncSessionProgress {
  state: 'reading' | 'preparing' | 'committing' | 'committed' | 'cancelling' | 'cancelled' | 'completed'
  mode: 'paged' | 'exclusive'
  pages: number
  inserts: number
  updates: number
  checkpoint?: SyncCheckpoint
  readMs?: number
  prepareMs?: number
  queueMs?: number
  commitMs?: number
}

export interface SyncSessionResult {
  status: 'completed' | 'cancelled'
  mode: 'paged' | 'exclusive'
  pages: number
  inserts: number
  updates: number
  checkpoint?: SyncCheckpoint
}

interface PullSession {
  reader: WalletStorageSyncReader
  writer: WalletStorageSync
  mode: 'paged' | 'exclusive'
  activeStorage: string
  atomicCheckpoint: boolean
  loadRequest: () => Promise<RequestSyncChunkArgs>
  prepare?: (args: RequestSyncChunkArgs, chunk: SyncChunk) => Promise<() => Promise<ProcessSyncChunkResult>>
  /** Must check destination/generation inside ownership immediately before any write. */
  commit: <T>(operation: () => Promise<T>) => Promise<T>
}

function boundedOption(value: number | undefined, name: string, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from 1 to ${maximum}`)
  }
  return value
}

function requestCheckpoint(args: RequestSyncChunkArgs): SyncCheckpoint {
  return validateSyncCheckpoint({ syncStateId: args.syncStateId ?? 0, since: args.since, offsets: args.offsets })
}

type ProgressNotifier = (state: SyncSessionProgress['state'], timing?: Partial<SyncSessionProgress>) => void

async function readAndPreparePage(
  session: PullSession,
  pageArgs: RequestSyncChunkArgs,
  cancelled: () => boolean,
  notify: ProgressNotifier
): Promise<
  { chunk: SyncChunk; apply: () => Promise<ProcessSyncChunkResult>; readMs: number; prepareMs: number } | undefined
> {
  notify('reading')
  if (cancelled()) return undefined
  const readAt = Date.now()
  const chunk = await session.reader.getSyncChunk(pageArgs)
  const readMs = Date.now() - readAt
  if (cancelled()) return undefined
  if (
    chunk.fromStorageIdentityKey !== pageArgs.fromStorageIdentityKey ||
    chunk.toStorageIdentityKey !== pageArgs.toStorageIdentityKey ||
    chunk.userIdentityKey !== pageArgs.identityKey
  ) {
    throw new WERR_INVALID_PARAMETER('chunk', 'bound to this sync source, destination and wallet identity')
  }
  if (chunk.user != null) chunk.user.activeStorage = session.activeStorage
  notify('preparing', { readMs })
  if (cancelled()) return undefined
  const prepareAt = Date.now()
  const apply =
    session.prepare == null
      ? async () => await session.writer.processSyncChunk(pageArgs, chunk)
      : await session.prepare(pageArgs, chunk)
  const prepareMs = Date.now() - prepareAt
  if (cancelled()) return undefined
  return { chunk, apply, readMs, prepareMs }
}

async function committedCheckpoint(
  session: PullSession,
  args: RequestSyncChunkArgs,
  reply: ProcessSyncChunkResult
): Promise<SyncCheckpoint> {
  if (reply.nextCheckpoint == null) return requestCheckpoint(await session.loadRequest())
  const expected = reply.done ? { syncStateId: args.syncStateId } : args
  return validateSyncCheckpoint(reply.nextCheckpoint, expected)
}

/** One page in flight; resume always starts with the destination's durable checkpoint. */
export async function runPullSession(session: PullSession, options: SyncSessionOptions): Promise<SyncSessionResult> {
  const maxItems = boundedOption(options.maxItems, 'maxItems', 1000)
  const maxRoughSize = boundedOption(options.maxRoughSize ?? 262144, 'maxRoughSize', 10000000)
  const { signal, onProgress } = options
  const result: SyncSessionResult = { status: 'completed', mode: session.mode, pages: 0, inserts: 0, updates: 0 }
  const notify = (state: SyncSessionProgress['state'], timing: Partial<SyncSessionProgress> = {}): void => {
    onProgress?.({
      ...result,
      ...timing,
      state,
      checkpoint: result.checkpoint == null ? undefined : validateSyncCheckpoint(result.checkpoint)
    })
  }
  const cancelled = (): boolean => {
    if (signal?.aborted !== true) return false
    result.status = 'cancelled'
    notify('cancelling')
    notify('cancelled')
    return true
  }
  if (cancelled()) return result
  let args = await session.commit(session.loadRequest)
  result.checkpoint = requestCheckpoint(args)
  args = {
    ...args,
    maxItems: Math.min(args.maxItems, maxItems),
    maxRoughSize: Math.min(args.maxRoughSize, maxRoughSize)
  }
  const budget = new SyncPageBudget()
  for (;;) {
    if (cancelled()) return result
    const pageArgs = {
      ...budget.apply(args),
      includeNextCheckpoint: true,
      requireMatchingCheckpoint: session.atomicCheckpoint
    }
    const prepared = await readAndPreparePage(session, pageArgs, cancelled, notify)
    if (prepared == null) return result
    const { chunk, apply, readMs, prepareMs } = prepared
    notify('committing', { readMs })
    const queuedAt = Date.now()
    let commitAt = queuedAt
    const committed = await session.commit(async () => {
      // A cancellation requested while queued must not start a destination write.
      if (signal?.aborted === true) return undefined
      commitAt = Date.now()
      const reply = await apply()
      throwSyncResultError(reply)
      const checkpoint = await committedCheckpoint(session, args, reply)
      return { reply, checkpoint }
    })
    if (committed == null) {
      cancelled()
      return result
    }
    const commitMs = Date.now() - commitAt
    const { reply, checkpoint } = committed
    if (!reply.done) assertSyncProgress(args, { ...args, ...checkpoint })
    budget.committed(chunk, readMs + prepareMs + commitMs, readMs + prepareMs)
    result.pages++
    result.inserts += reply.inserts
    result.updates += reply.updates
    result.checkpoint = checkpoint
    notify('committed', { readMs, prepareMs, queueMs: commitAt - queuedAt, commitMs })
    if (cancelled()) return result
    if (reply.done) {
      notify('completed')
      return result
    }
    args = { ...args, ...checkpoint }
  }
}
