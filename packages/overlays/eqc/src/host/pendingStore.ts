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

/** Asynchronous so a shared store can back several host instances. */
export interface PendingStore {
  get: (queryId: string) => Promise<PendingQuery | undefined>
  put: (record: PendingQuery) => Promise<'stored' | 'too-many-pending' | 'too-large'>
  /** Atomically claims a pending query for settlement. False when it is not claimable. */
  beginSettle: (queryId: string) => Promise<boolean>
  abortSettle: (queryId: string) => Promise<void>
  completeSettle: (queryId: string) => Promise<void>
}

export interface PendingStoreLimits {
  maxEntries: number
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

function sizeOf(record: PendingQuery): number {
  return record.payload.length + record.supplement.length
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

  async put(record: PendingQuery): Promise<'stored' | 'too-many-pending' | 'too-large'> {
    const size = sizeOf(record)
    if (size > this.limits.maxBytes) return 'too-large'
    this.purge()
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
