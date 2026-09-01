import { Beef, Hash, TelemetrySpan, Utils } from '@bsv/sdk'
import type { StorageProvider } from '../StorageProvider'
import type { TablePreparedBeef } from '../schema/tables/TablePreparedBeef.interfaces'
import { beefForTxids } from '../../utility/beefForTxids'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

export const PREPARED_BEEF_FORMAT_VERSION = 1

const DEFAULT_MAX_QUEUE_SIZE = 32
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const DEFAULT_BACKFILL_BATCH_SIZE = 32
const DEFAULT_BACKFILL_INTERVAL_MS = 100
// COOK targets normal funding calls, which ordinarily spend one managed-change
// source. Do not add a broad cache query in front of the canonical builder for
// unusually fragmented actions; those requests retain the established path.
const MAX_PREPARED_BEEF_LOOKUP_ROOTS = 32

export interface PreparedBeefOptions {
  /** Read prepared artifacts on the createAction proof path. Default false. */
  readEnabled?: boolean
  /** Prepare and persist artifacts after foreground work completes. Default false. */
  writeEnabled?: boolean
  /** Gradually prepare existing eligible managed-change roots. Default false. */
  backfillEnabled?: boolean
  /** Maximum queued roots. New background work is dropped when full. */
  maxQueueSize?: number
  /** Reject a prepared artifact larger than this many bytes. */
  maxArtifactBytes?: number
  /** Maximum roots selected by each low-priority backfill pass. */
  backfillBatchSize?: number
  /** Delay between backfill passes. */
  backfillIntervalMs?: number
}

export interface PreparedBeefPolicy {
  readEnabled: boolean
  writeEnabled: boolean
  backfillEnabled: boolean
  maxQueueSize: number
  maxArtifactBytes: number
  backfillBatchSize: number
  backfillIntervalMs: number
}

export interface PreparedBeefRoot {
  userId: number
  rootTxid: string
}

export interface PreparedBeefLookupResult {
  beef: Beef
  hitTxids: string[]
  missingTxids: string[]
  corruptCount: number
  byteLength: number
}

export interface PreparedBeefPreparation {
  userId: number
  rootTxids: string[]
  /**
   * Optional already-built source. It is retained only until the background
   * task runs and is never mutated by the coordinator.
   */
  sourceBeef?: Beef
}

/** Knex-owned extension used without adding server cache code to portable providers. */
export interface PreparedBeefStorage extends Pick<
  StorageProvider,
  'telemetry' | 'getBeefForTransaction' | 'getServices'
> {
  readonly preparedBeefPolicy: PreparedBeefPolicy
  findPreparedBeefs: (userId: number, rootTxids: string[]) => Promise<TablePreparedBeef[]>
  readPreparedBeefProofEpoch: () => Promise<number>
  upsertPreparedBeef: (artifact: TablePreparedBeef, expectedProofEpoch: number) => Promise<boolean>
  findPreparedBeefBackfillRoots: (limit: number, formatVersion: number) => Promise<PreparedBeefRoot[]>
}

export function defaultPreparedBeefPolicy(): PreparedBeefPolicy {
  return {
    readEnabled: false,
    writeEnabled: false,
    backfillEnabled: false,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    backfillBatchSize: DEFAULT_BACKFILL_BATCH_SIZE,
    backfillIntervalMs: DEFAULT_BACKFILL_INTERVAL_MS
  }
}
export function validatePreparedBeefPolicy(options?: PreparedBeefOptions): PreparedBeefPolicy {
  const policy = { ...defaultPreparedBeefPolicy(), ...options }
  for (const name of ['readEnabled', 'writeEnabled', 'backfillEnabled'] as const) {
    if (typeof policy[name] !== 'boolean') {
      throw new WERR_INVALID_PARAMETER(`preparedBeef.${name}`, 'a boolean')
    }
  }
  for (const name of ['maxQueueSize', 'maxArtifactBytes', 'backfillBatchSize'] as const) {
    if (!Number.isSafeInteger(policy[name]) || policy[name] < 1) {
      throw new WERR_INVALID_PARAMETER(`preparedBeef.${name}`, 'a positive safe integer')
    }
  }
  if (!Number.isSafeInteger(policy.backfillIntervalMs) || policy.backfillIntervalMs < 0) {
    throw new WERR_INVALID_PARAMETER('preparedBeef.backfillIntervalMs', 'a non-negative safe integer')
  }
  if (policy.backfillEnabled && !policy.writeEnabled) {
    throw new WERR_INVALID_PARAMETER('preparedBeef.backfillEnabled', 'false unless writeEnabled is true')
  }
  return policy
}

function checksum(bytes: Uint8Array): string {
  return Utils.toHex(Hash.sha256(Array.from(bytes)))
}

function validRootTransaction(beef: Beef, rootTxid: string): boolean {
  const root = beef.findTxid(rootTxid)
  return root != null && !root.isTxidOnly && root.rawTxUint8Array != null
}

/**
 * Read and validate prepared artifacts without performing chain or service
 * work. A malformed, stale, oversized, or unsupported row is a cache miss.
 */
export async function lookupPreparedBeefs(
  storage: PreparedBeefStorage,
  userId: number,
  rootTxids: string[],
  parent?: TelemetrySpan
): Promise<PreparedBeefLookupResult> {
  const result: PreparedBeefLookupResult = {
    beef: new Beef(),
    hitTxids: [],
    missingTxids: [...new Set(rootTxids)],
    corruptCount: 0,
    byteLength: 0
  }
  if (!storage.preparedBeefPolicy.readEnabled || result.missingTxids.length === 0) return result

  return await storage.telemetry.withSpan(
    'wallet.storage.prepared_beef.lookup',
    {
      component: 'wallet-storage',
      parent: parent?.context,
      attributes: { 'prepared_beef.requested_root_count': result.missingTxids.length }
    },
    async span => {
      const requestedTxids = result.missingTxids
      if (requestedTxids.length > MAX_PREPARED_BEEF_LOOKUP_ROOTS) {
        span.end({
          attributes: {
            'prepared_beef.hit_count': 0,
            'prepared_beef.miss_count': requestedTxids.length,
            'prepared_beef.corrupt_count': 0,
            'prepared_beef.bytes': 0,
            'prepared_beef.lookup_bypassed': true
          }
        })
        return result
      }
      try {
        const rows = await storage.findPreparedBeefs(userId, requestedTxids)
        const byTxid = new Map(rows.map(row => [row.rootTxid, row]))
        const missing: string[] = []
        const candidates: Array<{ rootTxid: string; fragment: Beef; byteLength: number }> = []
        for (const rootTxid of requestedTxids) {
          const row = byTxid.get(rootTxid)
          if (row?.state !== 'ready' || row.formatVersion !== PREPARED_BEEF_FORMAT_VERSION) {
            missing.push(rootTxid)
            continue
          }
          try {
            const bytes = Uint8Array.from(row.beef)
            if (
              bytes.length !== row.byteLength ||
              bytes.length > storage.preparedBeefPolicy.maxArtifactBytes ||
              checksum(bytes) !== row.checksum
            ) {
              throw new Error('prepared BEEF metadata mismatch')
            }
            const fragment = Beef.fromBinary(bytes)
            if (!validRootTransaction(fragment, rootTxid)) throw new Error('prepared BEEF root is incomplete')
            candidates.push({ rootTxid, fragment, byteLength: bytes.length })
          } catch {
            result.corruptCount++
            missing.push(rootTxid)
          }
        }
        try {
          // Build the aggregate separately. mergeBeef may partially mutate its
          // receiver before rejecting conflicting fragments; a cache failure
          // must never contaminate the canonical fallback BEEF.
          const aggregate = new Beef()
          for (const candidate of candidates) aggregate.mergeBeef(candidate.fragment)
          result.beef = aggregate
          result.hitTxids = candidates.map(candidate => candidate.rootTxid)
          result.byteLength = candidates.reduce((bytes, candidate) => bytes + candidate.byteLength, 0)
        } catch {
          result.beef = new Beef()
          result.hitTxids = []
          result.byteLength = 0
          result.corruptCount += candidates.length
          missing.push(...candidates.map(candidate => candidate.rootTxid))
        }
        const missingSet = new Set(missing)
        result.missingTxids = requestedTxids.filter(rootTxid => missingSet.has(rootTxid))
        span.end({
          attributes: {
            'prepared_beef.hit_count': result.hitTxids.length,
            'prepared_beef.miss_count': result.missingTxids.length,
            'prepared_beef.corrupt_count': result.corruptCount,
            'prepared_beef.bytes': result.byteLength
          }
        })
        return result
      } catch (error) {
        // COOK is an optimization, never a new createAction dependency.
        span.end({
          status: 'error',
          error,
          attributes: {
            'prepared_beef.hit_count': 0,
            'prepared_beef.miss_count': result.missingTxids.length,
            'prepared_beef.corrupt_count': 0,
            'prepared_beef.bytes': 0
          }
        })
        return result
      }
    }
  )
}

interface QueueItem extends PreparedBeefPreparation {}

/**
 * Bounded, best-effort COOK worker. No foreground caller awaits this queue.
 * Dropped or failed work is safe because canonical storage remains the source
 * of truth and the normal BEEF builder remains the read-path fallback.
 */
export class PreparedBeefCoordinator {
  private readonly queue: QueueItem[] = []
  private readonly pendingRoots = new Set<string>()
  private queuedRoots = 0
  private scheduled = false
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private stopped = false
  private backfillStarted = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly storage: PreparedBeefStorage) {}

  enqueue(preparation: PreparedBeefPreparation): boolean {
    if (this.stopped || !this.storage.preparedBeefPolicy.writeEnabled) return false
    const key = (rootTxid: string): string => `${preparation.userId}:${rootTxid}`
    const rootTxids = [...new Set(preparation.rootTxids)]
      .filter(rootTxid => !this.pendingRoots.has(key(rootTxid)))
    if (rootTxids.length === 0) return preparation.rootTxids.length > 0
    if (this.queuedRoots + rootTxids.length > this.storage.preparedBeefPolicy.maxQueueSize) return false
    this.queue.push({ ...preparation, rootTxids })
    for (const rootTxid of rootTxids) this.pendingRoots.add(key(rootTxid))
    this.queuedRoots += rootTxids.length
    this.schedule(0)
    return true
  }

  startBackfill(): void {
    if (
      this.backfillStarted ||
      this.stopped ||
      !this.storage.preparedBeefPolicy.writeEnabled ||
      !this.storage.preparedBeefPolicy.backfillEnabled
    ) return
    this.backfillStarted = true
    this.schedule(this.storage.preparedBeefPolicy.backfillIntervalMs)
  }

  async waitForIdle(): Promise<void> {
    if (!this.running && !this.scheduled && this.queue.length === 0) return
    await new Promise<void>(resolve => this.idleWaiters.push(resolve))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    this.pendingRoots.clear()
    this.queuedRoots = 0
    if (this.timer != null) clearTimeout(this.timer)
    this.timer = undefined
    this.scheduled = false
    if (!this.running) this.resolveIdle()
    await this.waitForIdle()
  }

  private schedule(delayMs: number): void {
    if (this.scheduled || this.running || this.stopped) return
    this.scheduled = true
    const timer = setTimeout(() => {
      this.timer = undefined
      this.scheduled = false
      void this.run()
    }, delayMs)
    this.timer = timer
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  }

  private async run(): Promise<void> {
    if (this.running) return
    if (this.stopped) {
      this.resolveIdle()
      return
    }
    this.running = true
    let item: QueueItem | undefined
    try {
      item = this.queue.shift()
      if (item != null) {
        this.queuedRoots -= item.rootTxids.length
        await this.prepare(item)
      } else if (this.backfillStarted) {
        await this.enqueueBackfillBatch()
      }
    } finally {
      if (item != null) {
        for (const rootTxid of item.rootTxids) this.pendingRoots.delete(`${item.userId}:${rootTxid}`)
      }
      this.running = false
      if (this.queue.length > 0) this.schedule(0)
      else if (this.backfillStarted && !this.stopped) {
        this.schedule(this.storage.preparedBeefPolicy.backfillIntervalMs)
      } else this.resolveIdle()
    }
  }

  private async enqueueBackfillBatch(): Promise<void> {
    try {
      const roots = await this.storage.findPreparedBeefBackfillRoots(
        this.storage.preparedBeefPolicy.backfillBatchSize,
        PREPARED_BEEF_FORMAT_VERSION
      )
      if (roots.length === 0) {
        this.backfillStarted = false
        return
      }
      const byUser = new Map<number, string[]>()
      // A backfill batch may be configured larger than the foreground queue.
      // Admit only what this empty-queue pass can hold, then select the
      // remaining roots after these artifacts have been persisted.
      for (const root of roots.slice(0, this.storage.preparedBeefPolicy.maxQueueSize)) {
        const txids = byUser.get(root.userId) ?? []
        txids.push(root.rootTxid)
        byUser.set(root.userId, txids)
      }
      for (const [userId, rootTxids] of byUser) {
        if (!this.enqueue({ userId, rootTxids })) break
      }
    } catch (error) {
      this.storage.telemetry.startSpan('wallet.storage.prepared_beef.backfill', {
        component: 'wallet-storage'
      }).end({ status: 'error', error })
      this.backfillStarted = false
    }
  }

  private async prepare(item: QueueItem): Promise<void> {
    await this.storage.telemetry.withSpan(
      'wallet.storage.prepared_beef.prepare',
      {
        component: 'wallet-storage',
        attributes: { 'prepared_beef.root_count': item.rootTxids.length }
      },
      async span => {
        let preparedCount = 0
        let rejectedCount = 0
        let preparedBytes = 0
        let proofEpoch: number
        try {
          // One epoch read covers this bounded batch. Every row write still
          // locks and compares the metadata record before it can commit.
          proofEpoch = await this.storage.readPreparedBeefProofEpoch()
        } catch (error) {
          span.end({
            status: 'error',
            error,
            attributes: {
              'prepared_beef.prepared_count': 0,
              'prepared_beef.rejected_count': item.rootTxids.length,
              'prepared_beef.bytes': 0
            }
          })
          return
        }
        for (const rootTxid of item.rootTxids) {
          try {
            const source = item.sourceBeef ?? await this.storage.getBeefForTransaction(rootTxid, {
              ignoreStorage: false,
              ignoreServices: true,
              ignoreNewProven: false
            })
            const exact = beefForTxids(source, [rootTxid])
            if (!validRootTransaction(exact, rootTxid)) throw new Error('prepared BEEF root is incomplete')
            if (!(await exact.verify(await this.storage.getServices().getChainTracker()))) {
              throw new Error('prepared BEEF failed verification')
            }
            const bytes = exact.toUint8Array()
            if (bytes.length > this.storage.preparedBeefPolicy.maxArtifactBytes) {
              throw new Error('prepared BEEF exceeds configured size limit')
            }
            const now = new Date()
            const row: TablePreparedBeef = {
              created_at: now,
              updated_at: now,
              preparedBeefId: 0,
              userId: item.userId,
              rootTxid,
              beef: Array.from(bytes),
              checksum: checksum(bytes),
              formatVersion: PREPARED_BEEF_FORMAT_VERSION,
              state: 'ready',
              txCount: exact.txs.length,
              bumpCount: exact.bumps.length,
              byteLength: bytes.length
            }
            if (!(await this.storage.upsertPreparedBeef(row, proofEpoch))) {
              // Proof state changed after verification. The invalidation won
              // the race, so do not reintroduce this artifact or suppress a
              // later backfill retry with a failure marker.
              rejectedCount++
              continue
            }
            preparedCount++
            preparedBytes += bytes.length
          } catch {
            rejectedCount++
            // A persistent rejection marker prevents optional backfill from
            // hot-looping on an unverifiable root. Normal canonical reads can
            // still queue an organic retry, which replaces this marker after
            // conditions recover.
            try {
              const now = new Date()
              const bytes = new Uint8Array()
              await this.storage.upsertPreparedBeef({
                created_at: now,
                updated_at: now,
                preparedBeefId: 0,
                userId: item.userId,
                rootTxid,
                beef: [],
                checksum: checksum(bytes),
                formatVersion: PREPARED_BEEF_FORMAT_VERSION,
                state: 'failed',
                txCount: 0,
                bumpCount: 0,
                byteLength: 0
              }, proofEpoch)
            } catch {
              // Persistence failure remains best effort. The foreground action
              // has already completed and canonical reads remain authoritative.
            }
          }
        }
        span.end({
          attributes: {
            'prepared_beef.prepared_count': preparedCount,
            'prepared_beef.rejected_count': rejectedCount,
            'prepared_beef.bytes': preparedBytes
          }
        })
      }
    )
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}
