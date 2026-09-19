import type { Attestation } from '../protocol/attestation.js'
import type { EconomicQuery } from '../protocol/query.js'

export type PendingState = 'pending' | 'settling' | 'settled'

export interface PendingQuery {
  queryId: string
  query: EconomicQuery
  clientIdentityKey: string
  attestation: Attestation
  payload: number[]
  supplement: number[]
  expiresAt: number
  state: PendingState
}

/** The outcome of a `put`. `duplicate` means the store already holds that queryId, untouched. */
export type PendingPutResult = 'stored' | 'duplicate' | 'too-many-pending' | 'too-large'

/** Asynchronous so a shared store can back several host instances. */
export interface PendingStore {
  get: (queryId: string) => Promise<PendingQuery | undefined>
  /** Never overwrites: a queryId the store already holds answers `duplicate`. */
  put: (record: PendingQuery) => Promise<PendingPutResult>
  /** Atomically claims a pending query for settlement. False when it is not claimable. */
  beginSettle: (queryId: string) => Promise<boolean>
  abortSettle: (queryId: string) => Promise<void>
  completeSettle: (queryId: string) => Promise<void>
}

export interface PendingStoreLimits {
  maxEntries: number
  /**
   * Estimated heap bytes held by cached payloads, not payload length. A `number[]` element costs
   * about {@link HEAP_BYTES_PER_ELEMENT} bytes, so the 256 MiB default holds roughly 32 MiB of
   * payload.
   */
  maxBytes: number
  maxPendingPerClient: number
  settledGraceMs: number
}

const DEFAULT_LIMITS: PendingStoreLimits = {
  maxEntries: 10_000,
  maxBytes: 256 * 1024 * 1024,
  maxPendingPerClient: 32,
  settledGraceMs: 60_000
}

/** A cached byte lives in a `number[]`, which V8 stores as a 64-bit slot rather than one byte. */
const HEAP_BYTES_PER_ELEMENT = 8

function sizeOf(record: PendingQuery): number {
  return (record.payload.length + record.supplement.length) * HEAP_BYTES_PER_ELEMENT
}

/**
 * Attestation is free and caches a payload, so the store is bounded. A full store rejects new
 * queries instead of evicting live ones, which would break honest clients mid-race.
 */
export class InMemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PendingQuery>()
  private readonly limits: PendingStoreLimits
  private readonly clock: () => number
  private bytes = 0

  constructor(limits: Partial<PendingStoreLimits> = {}, clock: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.clock = clock
  }

  async get(queryId: string): Promise<PendingQuery | undefined> {
    const record = this.records.get(queryId)
    if (record === undefined) return undefined
    if (this.clock() >= record.expiresAt + this.limits.settledGraceMs) {
      this.remove(record)
      return undefined
    }
    return record
  }

  async put(record: PendingQuery): Promise<PendingPutResult> {
    const size = sizeOf(record)
    if (size > this.limits.maxBytes) return 'too-large'
    this.purge()
    // Overwriting would leak the old record's bytes and reset a settle claim taken on it.
    if (this.records.has(record.queryId)) return 'duplicate'
    let pendingForClient = 0
    for (const existing of this.records.values()) {
      if (existing.clientIdentityKey === record.clientIdentityKey && existing.state !== 'settled') {
        pendingForClient++
      }
    }
    if (
      pendingForClient >= this.limits.maxPendingPerClient ||
      this.records.size >= this.limits.maxEntries ||
      this.bytes + size > this.limits.maxBytes
    ) {
      return 'too-many-pending'
    }
    this.records.set(record.queryId, record)
    this.bytes += size
    return 'stored'
  }

  async beginSettle(queryId: string): Promise<boolean> {
    const record = this.records.get(queryId)
    if (record === undefined || record.state !== 'pending') return false
    record.state = 'settling'
    return true
  }

  async abortSettle(queryId: string): Promise<void> {
    const record = this.records.get(queryId)
    if (record?.state === 'settling') record.state = 'pending'
  }

  async completeSettle(queryId: string): Promise<void> {
    const record = this.records.get(queryId)
    if (record === undefined) return
    this.bytes -= sizeOf(record)
    record.payload = []
    record.supplement = []
    record.state = 'settled'
  }

  private purge(): void {
    const now = this.clock()
    for (const record of this.records.values()) {
      if (now >= record.expiresAt + this.limits.settledGraceMs) this.remove(record)
    }
  }

  private remove(record: PendingQuery): void {
    this.records.delete(record.queryId)
    this.bytes -= sizeOf(record)
  }
}
