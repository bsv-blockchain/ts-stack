import { Random, Utils } from '@bsv/sdk'

import type { Attestation, Delivery } from '../protocol/attestation.js'
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
  /** The current settle claim, while `settling`. */
  claim?: string
  /** When the current settle claim was taken. */
  claimedAt?: number
  /** The signed delivery the client paid for, kept for replay until the retention ends. */
  delivery?: Delivery
  /** The payout transaction that settled the query. */
  txid?: string
  settledAt?: number
}

/** What a completed settlement leaves behind: the answer the client paid for, and the payment. */
export interface SettledDelivery {
  delivery: Delivery
  txid: string
}

/** The outcome of a `put`. `duplicate` means the store already holds that queryId, untouched. */
export type PendingPutResult = 'stored' | 'duplicate' | 'too-many-pending' | 'too-large'

/**
 * Asynchronous so a shared store can back several host instances. A store that should survive a
 * restart must persist every field, including `delivery`, before each call resolves.
 */
export interface PendingStore {
  get: (queryId: string) => Promise<PendingQuery | undefined>
  /** Never overwrites: a queryId the store already holds answers `duplicate`. */
  put: (record: PendingQuery) => Promise<PendingPutResult>
  /**
   * Atomically claims a query for settlement and returns the claim, or undefined when it is not
   * claimable. A pending, unexpired query is claimable, and so is one whose previous claim is
   * older than the settle lease, because the host that took it may have crashed mid-settlement.
   */
  beginSettle: (queryId: string) => Promise<string | undefined>
  /** Returns the query to pending, unless the claim was since replaced or settled. */
  abortSettle: (queryId: string, claim: string) => Promise<void>
  /**
   * Marks the query settled and keeps its signed delivery for replay. Any claim may complete a
   * settling query: a payment that went through is recorded even if its claim was reclaimed.
   */
  completeSettle: (queryId: string, claim: string, settled: SettledDelivery) => Promise<void>
}

export interface PendingStoreLimits {
  /** Every record counts, including expired and settled ones still inside the grace period. */
  maxEntries: number
  /**
   * Estimated heap bytes held by cached payloads, retained deliveries and stored queries, not
   * payload length. A `number[]` element costs about {@link HEAP_BYTES_PER_ELEMENT} bytes, so the
   * 256 MiB default holds roughly 32 MiB of payload. A stored query is charged
   * {@link HEAP_BYTES_PER_CHAR} bytes per character of its canonical JSON, and a retained
   * delivery the same per character of its base64 and signature.
   */
  maxBytes: number
  /** Unsettled, unexpired records one client may hold. */
  maxPendingPerClient: number
  /**
   * How long a record outlives its expiry, so a late collect is answered 409 or 410 instead of
   * 404. Only the record is kept: an unsettled record gives up its payload at expiry.
   */
  settledGraceMs: number
  /**
   * How long after settlement the signed delivery is kept, so a client whose collect response was
   * lost can collect again and receive it without paying twice. The record is kept at least this
   * long, even past its grace period.
   */
  deliveryRetentionMs: number
  /**
   * How long a settle claim holds. A collect that finds an older claim takes it over, so a host
   * that crashed between taking the payment and recording the delivery can still deliver.
   */
  settleLeaseMs: number
}

const DEFAULT_LIMITS: PendingStoreLimits = {
  maxEntries: 10_000,
  maxBytes: 256 * 1024 * 1024,
  maxPendingPerClient: 32,
  settledGraceMs: 60_000,
  deliveryRetentionMs: 600_000,
  settleLeaseMs: 120_000
}

/** A cached byte lives in a `number[]`, which V8 stores as a 64-bit slot rather than one byte. */
const HEAP_BYTES_PER_ELEMENT = 8

/** A UTF-16 character of a stored query or retained delivery is two bytes. */
const HEAP_BYTES_PER_CHAR = 2

function payloadBytesOf(record: PendingQuery): number {
  return (record.payload.length + record.supplement.length) * HEAP_BYTES_PER_ELEMENT
}

function queryBytesOf(record: PendingQuery): number {
  return canonicalJson(record.query).length * HEAP_BYTES_PER_CHAR
}

function deliveryBytesOf(delivery: Delivery): number {
  const chars =
    delivery.payload.length + (delivery.supplement?.length ?? 0) + delivery.signature.length
  return chars * HEAP_BYTES_PER_CHAR
}

/**
 * Attestation is free and caches a payload, so the store is bounded. A full store rejects new
 * queries instead of evicting live ones, which would break honest clients mid-race.
 *
 * A pending record whose `expiresAt` has passed is dead: collect answers 410 for it. It gives up
 * its payload and supplement and stops counting toward `maxPendingPerClient` the next time `get`,
 * `put`, or `beginSettle` runs, while the emptied record stays through the grace period. A
 * settling record keeps its payload, so a reclaimed settlement can still sign the delivery.
 *
 * Settling swaps the payload for the signed delivery, which is kept for `deliveryRetentionMs`.
 * Everything lives in process memory: a restart forgets every record, retained deliveries
 * included. A host that must replay paid deliveries across restarts needs a durable store.
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

  get(queryId: string): Promise<PendingQuery | undefined> {
    return Promise.resolve(this.lookup(queryId))
  }

  put(record: PendingQuery): Promise<PendingPutResult> {
    return Promise.resolve(this.insert(record))
  }

  beginSettle(queryId: string): Promise<string | undefined> {
    return Promise.resolve(this.claimFor(queryId))
  }

  abortSettle(queryId: string, claim: string): Promise<void> {
    const record = this.records.get(queryId)
    if (record?.state === 'settling' && record.claim === claim) {
      record.state = 'pending'
      delete record.claim
      delete record.claimedAt
    }
    return Promise.resolve()
  }

  completeSettle(queryId: string, _claim: string, settled: SettledDelivery): Promise<void> {
    const record = this.records.get(queryId)
    if (record?.state === 'settling') {
      this.releasePayload(record)
      record.state = 'settled'
      record.delivery = settled.delivery
      record.txid = settled.txid
      record.settledAt = this.clock()
      delete record.claim
      delete record.claimedAt
      // Charged even past maxBytes: the client has paid, and the payload just freed was larger.
      this.charge(record, deliveryBytesOf(settled.delivery))
    }
    return Promise.resolve()
  }

  private lookup(queryId: string): PendingQuery | undefined {
    const record = this.records.get(queryId)
    if (record === undefined) return undefined
    const now = this.clock()
    if (now >= this.retainUntil(record)) {
      this.remove(record)
      return undefined
    }
    this.releaseIfStale(record, now)
    return record
  }

  private insert(record: PendingQuery): PendingPutResult {
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
    this.charged.set(record.queryId, 0)
    this.charge(record, size)
    return 'stored'
  }

  private claimFor(queryId: string): string | undefined {
    const record = this.records.get(queryId)
    const now = this.clock()
    if (record?.state === 'pending') {
      if (this.releaseIfStale(record, now)) return undefined
    } else if (
      record?.state !== 'settling' ||
      now < (record.claimedAt ?? 0) + this.limits.settleLeaseMs
    ) {
      return undefined
    }
    const claim = Utils.toHex(Random(16))
    record.state = 'settling'
    record.claim = claim
    record.claimedAt = now
    return claim
  }

  /** A record is forgotten after its grace, after its delivery retention, and after its lease. */
  private retainUntil(record: PendingQuery): number {
    const grace = record.expiresAt + this.limits.settledGraceMs
    if (record.state === 'settled') {
      return Math.max(grace, (record.settledAt ?? 0) + this.limits.deliveryRetentionMs)
    }
    if (record.state === 'settling') {
      const lease = (record.claimedAt ?? 0) + this.limits.settleLeaseMs
      return Math.max(grace, lease + this.limits.settledGraceMs)
    }
    return grace
  }

  private purge(now: number): void {
    for (const record of this.records.values()) {
      if (now >= this.retainUntil(record)) this.remove(record)
      else this.releaseIfStale(record, now)
    }
  }

  /**
   * Releases what a record no longer needs: the payload of a pending record past its expiry, and
   * a retained delivery past its retention. True when the record is pending and expired.
   */
  private releaseIfStale(record: PendingQuery, now: number): boolean {
    if (record.state === 'settled') {
      const retained = record.delivery
      if (
        retained !== undefined &&
        now >= (record.settledAt ?? 0) + this.limits.deliveryRetentionMs
      ) {
        delete record.delivery
        this.charge(record, -deliveryBytesOf(retained))
      }
      return false
    }
    if (record.state !== 'pending' || now < record.expiresAt) return false
    this.releasePayload(record)
    return true
  }

  /** Empties the cached bytes and keeps charging only what the record still holds. */
  private releasePayload(record: PendingQuery): void {
    const freed = payloadBytesOf(record)
    if (freed === 0) return
    record.payload = []
    record.supplement = []
    this.charge(record, -freed)
  }

  private charge(record: PendingQuery, bytes: number): void {
    this.charged.set(record.queryId, (this.charged.get(record.queryId) ?? 0) + bytes)
    this.bytes += bytes
  }

  private remove(record: PendingQuery): void {
    this.records.delete(record.queryId)
    this.bytes -= this.charged.get(record.queryId) ?? 0
    this.charged.delete(record.queryId)
  }
}
