import type { Attestation } from '../protocol/attestation.js'
import { canonicalJson } from '../protocol/canonicalJson.js'
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
  /** Every record counts, including expired and settled ones still inside the grace period. */
  maxEntries: number
  /**
   * Estimated heap bytes held by cached payloads and stored queries, not payload length. A
   * `number[]` element costs about {@link HEAP_BYTES_PER_ELEMENT} bytes, so the 256 MiB default
   * holds roughly 32 MiB of payload. A stored query is charged
   * {@link HEAP_BYTES_PER_QUERY_CHAR} bytes per character of its canonical JSON.
   */
  maxBytes: number
  /** Unsettled, unexpired records one client may hold. */
  maxPendingPerClient: number
  /**
   * How long a record outlives its expiry, so a late collect is answered 409 or 410 instead of
   * 404. Only the record is kept: an unsettled record gives up its payload at expiry.
   */
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

/** The stored query is a client-sized object; a UTF-16 character of its canonical JSON is two. */
const HEAP_BYTES_PER_QUERY_CHAR = 2

function payloadBytesOf(record: PendingQuery): number {
  return (record.payload.length + record.supplement.length) * HEAP_BYTES_PER_ELEMENT
}

function queryBytesOf(record: PendingQuery): number {
  return canonicalJson(record.query).length * HEAP_BYTES_PER_QUERY_CHAR
}

/**
 * Attestation is free and caches a payload, so the store is bounded. A full store rejects new
 * queries instead of evicting live ones, which would break honest clients mid-race.
 *
 * An unsettled record whose `expiresAt` has passed is dead: collect answers 410 for it. It gives
 * up its payload and supplement and stops counting toward `maxPendingPerClient` the next time
 * `get`, `put`, or `beginSettle` runs, while the emptied record stays through the grace period.
 */
export class InMemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PendingQuery>()
  private readonly limits: PendingStoreLimits
  private readonly clock: () => number
  /** Bytes each record is currently charged, so a release and a removal never double count. */
  private readonly charged = new Map<string, number>()
  private bytes = 0

  constructor(limits: Partial<PendingStoreLimits> = {}, clock: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.clock = clock
  }

  async get(queryId: string): Promise<PendingQuery | undefined> {
    const record = this.records.get(queryId)
    if (record === undefined) return undefined
    const now = this.clock()
    if (now >= record.expiresAt + this.limits.settledGraceMs) {
      this.remove(record)
      return undefined
    }
    this.releaseIfExpired(record, now)
    return record
  }

  async put(record: PendingQuery): Promise<PendingPutResult> {
    const size = payloadBytesOf(record) + queryBytesOf(record)
    if (size > this.limits.maxBytes) return 'too-large'
    const now = this.clock()
    this.purge(now)
    // Overwriting would leak the old record's bytes and reset a settle claim taken on it.
    if (this.records.has(record.queryId)) return 'duplicate'
    let pendingForClient = 0
    for (const existing of this.records.values()) {
      if (
        existing.clientIdentityKey === record.clientIdentityKey &&
        existing.state !== 'settled' &&
        now < existing.expiresAt
      ) {
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
    this.charged.set(record.queryId, size)
    this.bytes += size
    return 'stored'
  }

  async beginSettle(queryId: string): Promise<boolean> {
    const record = this.records.get(queryId)
    if (record === undefined || record.state !== 'pending') return false
    if (this.releaseIfExpired(record, this.clock())) return false
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
    this.releasePayload(record)
    record.state = 'settled'
  }

  private purge(now: number): void {
    for (const record of this.records.values()) {
      if (now >= record.expiresAt + this.limits.settledGraceMs) this.remove(record)
      else this.releaseIfExpired(record, now)
    }
  }

  /** True when the record is unsettled and past its expiry, whether released now or earlier. */
  private releaseIfExpired(record: PendingQuery, now: number): boolean {
    if (record.state === 'settled' || now < record.expiresAt) return false
    this.releasePayload(record)
    return true
  }

  /** Empties the cached bytes and keeps charging only what the record still holds: its query. */
  private releasePayload(record: PendingQuery): void {
    const freed = payloadBytesOf(record)
    if (freed === 0) return
    record.payload = []
    record.supplement = []
    this.charged.set(record.queryId, (this.charged.get(record.queryId) ?? freed) - freed)
    this.bytes -= freed
  }

  private remove(record: PendingQuery): void {
    this.records.delete(record.queryId)
    this.bytes -= this.charged.get(record.queryId) ?? 0
    this.charged.delete(record.queryId)
  }
}
