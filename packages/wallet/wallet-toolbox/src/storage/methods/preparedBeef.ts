import { Beef, Hash, TelemetrySpan, Utils } from '@bsv/sdk'
import type { StorageProvider } from '../StorageProvider'
import type { TablePreparedBeef } from '../schema/tables/TablePreparedBeef.interfaces'
import { beefForTxids } from '../../utility/beefForTxids'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

export const PREPARED_BEEF_FORMAT_VERSION = 1

const DEFAULT_MAX_QUEUE_SIZE = 32
const DEFAULT_MAX_QUEUE_SIZE_PER_USER = 4
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_ARTIFACT_TRANSACTIONS = 256
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
  /** Maximum queued or running roots for one user. */
  maxQueueSizePerUser?: number
  /** Reject a prepared artifact larger than this many bytes. */
  maxArtifactBytes?: number
  /** Reject source or prepared BEEF graphs with more transactions. */
  maxArtifactTransactions?: number
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
  maxQueueSizePerUser: number
  maxArtifactBytes: number
  maxArtifactTransactions: number
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
}

/** Knex-owned extension used without adding server cache code to portable providers. */
export interface PreparedBeefStorage extends Pick<
  StorageProvider,
  'telemetry' | 'getBeefForTransaction' | 'getServices'
> {
  readonly preparedBeefPolicy: PreparedBeefPolicy
  preparedBeefReadsEnabled?: () => boolean
  findPreparedBeefs: (userId: number, rootTxids: string[]) => Promise<TablePreparedBeef[]>
  readPreparedBeefProofEpoch: () => Promise<number>
  readPreparedBeefSourceByteLength: (rootTxid: string) => Promise<number | undefined>
  upsertPreparedBeef: (artifact: TablePreparedBeef, expectedProofEpoch: number) => Promise<boolean>
  findPreparedBeefBackfillRoots: (limit: number, formatVersion: number) => Promise<PreparedBeefRoot[]>
}

export function defaultPreparedBeefPolicy(): PreparedBeefPolicy {
  return {
    readEnabled: false,
    writeEnabled: false,
    backfillEnabled: false,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    maxQueueSizePerUser: DEFAULT_MAX_QUEUE_SIZE_PER_USER,
    maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    maxArtifactTransactions: DEFAULT_MAX_ARTIFACT_TRANSACTIONS,
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
  for (const name of [
    'maxQueueSize',
    'maxQueueSizePerUser',
    'maxArtifactBytes',
    'maxArtifactTransactions',
    'backfillBatchSize'
  ] as const) {
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
  if (policy.maxQueueSizePerUser > policy.maxQueueSize) {
    throw new WERR_INVALID_PARAMETER('preparedBeef.maxQueueSizePerUser', 'no greater than maxQueueSize')
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
 * Cheap, conservative work estimate which avoids serializing or verifying a
 * BEEF. Exact serialized size is still enforced before persistence.
 */
function estimatedBeefBytes(beef: Beef): number {
  let bytes = 16
  for (const tx of beef.txs) {
    bytes += 40
    const rawTx = tx.rawTxUint8Array
    if (rawTx != null) bytes += rawTx.length
  }
  for (const bump of beef.bumps) {
    bytes += 16
    for (const level of bump.path) bytes += 8 + level.length * 40
  }
  return bytes
}

function isAdmissibleBeef(beef: Beef, policy: PreparedBeefPolicy): boolean {
  return beef.txs.length <= policy.maxArtifactTransactions &&
    estimatedBeefBytes(beef) <= policy.maxArtifactBytes
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
  if (
    !storage.preparedBeefPolicy.readEnabled ||
    storage.preparedBeefReadsEnabled?.() === false ||
    result.missingTxids.length === 0
  ) return result

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

interface QueueItem {
  userId: number
  rootTxids: string[]
}

/**
 * Bounded, best-effort COOK worker. No foreground caller awaits this queue.
 * Dropped or failed work is safe because canonical storage remains the source
 * of truth and the normal BEEF builder remains the read-path fallback.
 */
export class PreparedBeefCoordinator {
  private readonly queue: QueueItem[] = []
  private readonly pendingRoots = new Set<string>()
  private readonly pendingRootsByUser = new Map<number, number>()
  private admittedRoots = 0
  private scheduled = false
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private stopped = false
  private backfillStarted = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly storage: PreparedBeefStorage) {}

  enqueue(preparation: PreparedBeefPreparation): boolean {
    if (this.stopped || !this.storage.preparedBeefPolicy.writeEnabled) return false
    if (!Number.isSafeInteger(preparation.userId) || preparation.userId < 1) return false
    if (preparation.rootTxids.some(rootTxid => !/^[0-9a-f]{64}$/i.test(rootTxid))) return false
    const key = (rootTxid: string): string => `${preparation.userId}:${rootTxid}`
    const rootTxids = [...new Set(preparation.rootTxids)]
      .filter(rootTxid => !this.pendingRoots.has(key(rootTxid)))
    if (rootTxids.length === 0) return preparation.rootTxids.length > 0
    const globalCapacity = this.storage.preparedBeefPolicy.maxQueueSize - this.admittedRoots
    const userCapacity = this.storage.preparedBeefPolicy.maxQueueSizePerUser -
      (this.pendingRootsByUser.get(preparation.userId) ?? 0)
    const admitted = rootTxids.slice(0, Math.max(0, Math.min(globalCapacity, userCapacity)))
    if (admitted.length === 0) return false
    // Deliberately retain identifiers only. A canonical source BEEF can carry
    // megabytes of tenant-controlled proof material and must not sit in a
    // shared queue while other users wait.
    this.queue.push({ userId: preparation.userId, rootTxids: admitted })
    for (const rootTxid of admitted) this.pendingRoots.add(key(rootTxid))
    this.admittedRoots += admitted.length
    this.pendingRootsByUser.set(
      preparation.userId,
      (this.pendingRootsByUser.get(preparation.userId) ?? 0) + admitted.length
    )
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
    for (const item of this.queue.splice(0)) this.releaseAdmission(item)
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
        await this.prepare(item)
      } else if (this.backfillStarted) {
        await this.enqueueBackfillBatch()
      }
    } finally {
      if (item != null) {
        this.releaseAdmission(item)
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
      const selectedByUser = new Map<number, number>()
      for (const root of roots.slice(0, this.storage.preparedBeefPolicy.maxQueueSize)) {
        const selected = selectedByUser.get(root.userId) ?? 0
        if (selected >= this.storage.preparedBeefPolicy.maxQueueSizePerUser) continue
        const txids = byUser.get(root.userId) ?? []
        txids.push(root.rootTxid)
        byUser.set(root.userId, txids)
        selectedByUser.set(root.userId, selected + 1)
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
          const byteLength = await this.prepareRoot(item.userId, rootTxid, proofEpoch)
          if (byteLength == null) rejectedCount++
          else {
            preparedCount++
            preparedBytes += byteLength
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

  private async prepareRoot(userId: number, rootTxid: string, proofEpoch: number): Promise<number | undefined> {
    try {
      return await this.buildAndPersistReadyArtifact(userId, rootTxid, proofEpoch)
    } catch {
      // A persistent rejection marker prevents optional backfill from
      // hot-looping on an unverifiable root. Normal canonical reads can still
      // queue an organic retry, which replaces this marker after recovery.
      await this.persistFailureMarker(userId, rootTxid, proofEpoch).catch(() => {
        // Persistence remains best effort. The foreground action has already
        // completed and canonical reads remain authoritative.
      })
      return undefined
    }
  }

  private async buildAndPersistReadyArtifact(
    userId: number,
    rootTxid: string,
    proofEpoch: number
  ): Promise<number | undefined> {
    const storedBytes = await this.storage.readPreparedBeefSourceByteLength(rootTxid)
    if (storedBytes != null && storedBytes > this.storage.preparedBeefPolicy.maxArtifactBytes) {
      throw new Error('prepared BEEF stored source exceeds configured byte limit')
    }
    const source = await this.storage.getBeefForTransaction(rootTxid, {
      ignoreStorage: false,
      ignoreServices: true,
      ignoreNewProven: false
    })
    // Bound attacker-influenced graph work before dependency selection, proof
    // verification, or exact serialization.
    if (!isAdmissibleBeef(source, this.storage.preparedBeefPolicy)) {
      throw new Error('prepared BEEF source exceeds configured resource limits')
    }
    const exact = beefForTxids(source, [rootTxid])
    if (exact.txs.length > this.storage.preparedBeefPolicy.maxArtifactTransactions) {
      throw new Error('prepared BEEF exceeds configured transaction limit')
    }
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
      userId,
      rootTxid,
      beef: Array.from(bytes),
      checksum: checksum(bytes),
      formatVersion: PREPARED_BEEF_FORMAT_VERSION,
      state: 'ready',
      txCount: exact.txs.length,
      bumpCount: exact.bumps.length,
      byteLength: bytes.length
    }
    // Proof state changed after verification when this returns false. The
    // invalidation won the race, so do not add a failure marker that suppresses
    // a later backfill retry.
    return await this.storage.upsertPreparedBeef(row, proofEpoch) ? bytes.length : undefined
  }

  private async persistFailureMarker(userId: number, rootTxid: string, proofEpoch: number): Promise<void> {
    const now = new Date()
    const bytes = new Uint8Array()
    await this.storage.upsertPreparedBeef({
      created_at: now,
      updated_at: now,
      preparedBeefId: 0,
      userId,
      rootTxid,
      beef: [],
      checksum: checksum(bytes),
      formatVersion: PREPARED_BEEF_FORMAT_VERSION,
      state: 'failed',
      txCount: 0,
      bumpCount: 0,
      byteLength: 0
    }, proofEpoch)
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private releaseAdmission(item: QueueItem): void {
    for (const rootTxid of item.rootTxids) this.pendingRoots.delete(`${item.userId}:${rootTxid}`)
    this.admittedRoots = Math.max(0, this.admittedRoots - item.rootTxids.length)
    const userRoots = (this.pendingRootsByUser.get(item.userId) ?? 0) - item.rootTxids.length
    if (userRoots <= 0) this.pendingRootsByUser.delete(item.userId)
    else this.pendingRootsByUser.set(item.userId, userRoots)
  }
}
