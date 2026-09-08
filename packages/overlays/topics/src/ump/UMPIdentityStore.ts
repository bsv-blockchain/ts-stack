import { Collection, Db, MongoServerError } from 'mongodb'
import type { UMPRecord } from './types.js'

const DEFAULT_PENDING_RESERVATION_TTL_MS = 15 * 60 * 1000
const LEGACY_BOOTSTRAP_ID = 'legacy-ump-reservations-v1'

export interface UMPIdentityClaim {
  outpoint: string
  presentationHash: string
  recoveryHash: string
}

export interface UMPIdentityReservationStore {
  reserve: (claim: UMPIdentityClaim, consumedOutpoints: string[]) => Promise<void>
  confirm: (outpoint: string) => Promise<void>
  abort: (outpoint: string) => Promise<void>
  release: (outpoint: string) => Promise<void>
}

interface UMPIdentityReservation {
  _id: string
  kind: 'presentation' | 'recovery'
  hash: string
  ownerOutpoint: string
  /** TTL-indexed only while the first owner is provisional. */
  pendingUntil?: Date
  /** A transfer remains separate so expiry never replaces a confirmed owner. */
  pendingOwnerOutpoint?: string
  pendingOwnerUntil?: Date
}

interface BootstrapMarker {
  _id: string
  completedAt: Date
}

interface ClaimMutation {
  id: string
  previous: UMPIdentityReservation | null
  claimedField: 'owner' | 'pendingOwner'
}

interface ReservationEntry {
  id: string
  kind: 'presentation' | 'recovery'
  hash: string
}

export class UMPIdentityConflictError extends Error {
  constructor(readonly kind: 'presentation' | 'recovery') {
    super(`The UMP ${kind} hash is already reserved by another unspent outpoint.`)
    this.name = 'UMPIdentityConflictError'
  }
}

function reservationEntries(
  claim: UMPIdentityClaim
): ReservationEntry[] {
  return [
    {
      id: `presentation:${claim.presentationHash}`,
      kind: 'presentation',
      hash: claim.presentationHash
    },
    {
      id: `recovery:${claim.recoveryHash}`,
      kind: 'recovery',
      hash: claim.recoveryHash
    }
  ]
}

interface InMemoryReservation {
  ownerOutpoint: string
  confirmed: boolean
  pendingUntil?: number
  pendingOwnerOutpoint?: string
  pendingOwnerUntil?: number
}

/**
 * Process-local reservation store for direct TopicManager consumers and tests.
 * Production multi-replica overlays should use MongoUMPIdentityStore and share
 * that instance with the matching lookup service.
 */
export class InMemoryUMPIdentityStore implements UMPIdentityReservationStore {
  private readonly reservations = new Map<string, InMemoryReservation>()

  constructor(private readonly pendingReservationTtlMs = DEFAULT_PENDING_RESERVATION_TTL_MS) {
    if (!Number.isSafeInteger(pendingReservationTtlMs) || pendingReservationTtlMs <= 0) {
      throw new TypeError('pendingReservationTtlMs must be a positive safe integer.')
    }
  }

  async reserve(claim: UMPIdentityClaim, consumedOutpoints: string[]): Promise<void> {
    this.removeExpiredPendingReservations()
    const consumed = new Set(consumedOutpoints)
    const acquired: Array<{ id: string; previous?: InMemoryReservation }> = []

    try {
      for (const entry of reservationEntries(claim)) {
        const mutation = this.claimOne(entry, claim.outpoint, consumed)
        if (mutation != null) acquired.push({ id: entry.id, ...mutation })
      }
    } catch (error) {
      acquired.reverse()
      for (const entry of acquired) {
        if (entry.previous == null) this.reservations.delete(entry.id)
        else this.reservations.set(entry.id, entry.previous)
      }
      throw error
    }
  }

  async confirm(outpoint: string): Promise<void> {
    for (const [id, reservation] of this.reservations) {
      if (reservation.pendingOwnerOutpoint === outpoint) {
        this.reservations.set(id, { ownerOutpoint: outpoint, confirmed: true })
      } else if (reservation.ownerOutpoint === outpoint) {
        const { pendingUntil: _pendingUntil, ...confirmed } = reservation
        this.reservations.set(id, { ...confirmed, confirmed: true })
      }
    }
  }

  async abort(outpoint: string): Promise<void> {
    for (const [id, reservation] of this.reservations) {
      if (reservation.pendingOwnerOutpoint === outpoint) {
        const {
          pendingOwnerOutpoint: _pending,
          pendingOwnerUntil: _pendingUntil,
          ...confirmed
        } = reservation
        this.reservations.set(id, confirmed)
      } else if (reservation.ownerOutpoint === outpoint && !reservation.confirmed) {
        this.reservations.delete(id)
      }
    }
  }

  async release(outpoint: string): Promise<void> {
    for (const [id, reservation] of this.reservations) {
      if (reservation.ownerOutpoint === outpoint) {
        if (reservation.pendingOwnerOutpoint == null) this.reservations.delete(id)
        else {
          this.reservations.set(id, {
            ownerOutpoint: reservation.pendingOwnerOutpoint,
            confirmed: false,
            pendingUntil: reservation.pendingOwnerUntil
          })
        }
      } else if (reservation.pendingOwnerOutpoint === outpoint) {
        const {
          pendingOwnerOutpoint: _pending,
          pendingOwnerUntil: _pendingUntil,
          ...confirmed
        } = reservation
        this.reservations.set(id, confirmed)
      }
    }
  }

  private claimOne(
    entry: ReservationEntry,
    ownerOutpoint: string,
    consumed: Set<string>
  ): { previous?: InMemoryReservation } | undefined {
    const current = this.reservations.get(entry.id)
    if (current?.ownerOutpoint === ownerOutpoint && current.pendingOwnerOutpoint == null) {
      return undefined
    }
    if (current?.pendingOwnerOutpoint === ownerOutpoint) return undefined
    if (current != null && (!current.confirmed || !consumed.has(current.ownerOutpoint))) {
      throw new UMPIdentityConflictError(entry.kind)
    }

    const expiresAt = Date.now() + this.pendingReservationTtlMs
    if (current == null) {
      this.reservations.set(entry.id, {
        ownerOutpoint,
        confirmed: false,
        pendingUntil: expiresAt
      })
      return {}
    }
    this.reservations.set(entry.id, {
      ...current,
      pendingOwnerOutpoint: ownerOutpoint,
      pendingOwnerUntil: expiresAt
    })
    return { previous: { ...current } }
  }

  private removeExpiredPendingReservations(): void {
    const now = Date.now()
    for (const [id, reservation] of this.reservations) {
      if (
        !reservation.confirmed &&
        reservation.pendingUntil != null &&
        reservation.pendingUntil <= now
      ) {
        this.reservations.delete(id)
      } else if (
        reservation.pendingOwnerOutpoint != null &&
        reservation.pendingOwnerUntil != null &&
        reservation.pendingOwnerUntil <= now
      ) {
        const {
          pendingOwnerOutpoint: _pending,
          pendingOwnerUntil: _pendingUntil,
          ...confirmed
        } = reservation
        this.reservations.set(id, confirmed)
      }
    }
  }
}

/**
 * Mongo-backed atomic reservation store shared by UMP admission and lookup.
 * Each hash is its document key, so concurrent first-writer claims are
 * serialized by MongoDB even when several overlay replicas receive a TX.
 */
export class MongoUMPIdentityStore implements UMPIdentityReservationStore {
  private readonly reservations: Collection<UMPIdentityReservation>
  private readonly records: Collection<UMPRecord>
  private readonly migrations: Collection<BootstrapMarker>
  private initialization?: Promise<void>

  constructor(
    db: Db,
    private readonly pendingReservationTtlMs = DEFAULT_PENDING_RESERVATION_TTL_MS
  ) {
    if (!Number.isSafeInteger(pendingReservationTtlMs) || pendingReservationTtlMs <= 0) {
      throw new TypeError('pendingReservationTtlMs must be a positive safe integer.')
    }
    this.reservations = db.collection<UMPIdentityReservation>('ump_identity_reservations')
    this.records = db.collection<UMPRecord>('ump')
    this.migrations = db.collection<BootstrapMarker>('ump_identity_reservation_migrations')
  }

  async reserve(claim: UMPIdentityClaim, consumedOutpoints: string[]): Promise<void> {
    await this.ensureInitialized()
    const acquired: ClaimMutation[] = []

    try {
      for (const entry of reservationEntries(claim)) {
        const mutation = await this.claimOne(entry, claim.outpoint, consumedOutpoints)
        if (mutation != null) acquired.push(mutation)
      }
    } catch (error) {
      await this.rollback(acquired, claim.outpoint)
      throw error
    }
  }

  async confirm(outpoint: string): Promise<void> {
    await this.ensureInitialized()
    await this.reservations.updateMany(
      { pendingOwnerOutpoint: outpoint },
      {
        $set: { ownerOutpoint: outpoint },
        $unset: { pendingOwnerOutpoint: '', pendingOwnerUntil: '', pendingUntil: '' }
      }
    )
    await this.reservations.updateMany(
      { ownerOutpoint: outpoint },
      { $unset: { pendingUntil: '' } }
    )
  }

  async abort(outpoint: string): Promise<void> {
    await this.ensureInitialized()
    await this.reservations.updateMany(
      { pendingOwnerOutpoint: outpoint },
      { $unset: { pendingOwnerOutpoint: '', pendingOwnerUntil: '' } }
    )
    await this.reservations.deleteMany({
      ownerOutpoint: outpoint,
      pendingUntil: { $exists: true }
    })
  }

  async release(outpoint: string): Promise<void> {
    await this.ensureInitialized()
    const owned = await this.reservations.find({ ownerOutpoint: outpoint }).toArray()
    for (const reservation of owned) {
      if (
        reservation.pendingOwnerOutpoint != null &&
        reservation.pendingOwnerUntil != null &&
        reservation.pendingOwnerUntil.getTime() > Date.now()
      ) {
        await this.reservations.updateOne(
          {
            _id: reservation._id,
            ownerOutpoint: outpoint,
            pendingOwnerOutpoint: reservation.pendingOwnerOutpoint
          },
          {
            $set: {
              ownerOutpoint: reservation.pendingOwnerOutpoint,
              pendingUntil: reservation.pendingOwnerUntil
            },
            $unset: { pendingOwnerOutpoint: '', pendingOwnerUntil: '' }
          }
        )
      } else {
        await this.reservations.deleteOne({ _id: reservation._id, ownerOutpoint: outpoint })
      }
    }
    await this.reservations.updateMany(
      { pendingOwnerOutpoint: outpoint },
      { $unset: { pendingOwnerOutpoint: '', pendingOwnerUntil: '' } }
    )
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization == null) {
      const attempt = this.initialize()
      this.initialization = attempt
      try {
        await attempt
      } catch (error) {
        if (this.initialization === attempt) this.initialization = undefined
        throw error
      }
      return
    }
    await this.initialization
  }

  private async initialize(): Promise<void> {
    await this.reservations.createIndex(
      { pendingUntil: 1 },
      { expireAfterSeconds: 0, name: 'ump_pending_reservation_expiry' }
    )
    await this.reservations.createIndex({ ownerOutpoint: 1 }, { name: 'ump_reservation_owner' })
    await this.reservations.createIndex(
      { pendingOwnerOutpoint: 1 },
      { name: 'ump_pending_reservation_owner' }
    )

    if (await this.migrations.findOne({ _id: LEGACY_BOOTSTRAP_ID })) return

    // Preserve the first already-indexed occurrence when upgrading an overlay
    // that predates reservations. Historical ambiguity remains visible to
    // lookup clients and can be resolved with a WAB pin; it is never silently
    // rewritten here. The marker makes this one-time work retryable after a
    // failed startup without repeating it on every process start.
    const cursor = this.records.find({}).sort({ _id: 1 })
    for await (const record of cursor) {
      const claim: UMPIdentityClaim = {
        outpoint: `${record.txid}.${record.outputIndex}`,
        presentationHash: record.presentationHash,
        recoveryHash: record.recoveryHash
      }
      for (const entry of reservationEntries(claim)) {
        try {
          await this.reservations.updateOne(
            { _id: entry.id },
            {
              $setOnInsert: {
                _id: entry.id,
                kind: entry.kind,
                hash: entry.hash,
                ownerOutpoint: claim.outpoint
              }
            },
            { upsert: true }
          )
        } catch (error) {
          if (!this.isDuplicateKey(error)) throw error
        }
      }
    }
    await this.migrations.updateOne(
      { _id: LEGACY_BOOTSTRAP_ID },
      { $setOnInsert: { _id: LEGACY_BOOTSTRAP_ID, completedAt: new Date() } },
      { upsert: true }
    )
  }

  private async claimOne(
    entry: ReservationEntry,
    ownerOutpoint: string,
    consumedOutpoints: string[]
  ): Promise<ClaimMutation | null> {
    for (;;) {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + this.pendingReservationTtlMs)
      const current = await this.reservations.findOne({ _id: entry.id })
      let result: ClaimMutation | null | false
      if (current == null) {
        result = await this.insertInitialClaim(entry, ownerOutpoint, expiresAt)
      } else {
        result = await this.claimExistingReservation(
          entry,
          current,
          ownerOutpoint,
          consumedOutpoints,
          now,
          expiresAt
        )
      }
      if (result !== false) return result
    }
  }

  private async claimExistingReservation(
    entry: ReservationEntry,
    current: UMPIdentityReservation,
    ownerOutpoint: string,
    consumedOutpoints: string[],
    now: Date,
    expiresAt: Date
  ): Promise<ClaimMutation | null | false> {
    const renewed = await this.renewExistingClaim(current, ownerOutpoint, expiresAt)
    if (renewed !== undefined) return renewed

    if (current.pendingOwnerOutpoint != null) {
      if (await this.clearExpiredSuccessor(current, now)) return false
      throw new UMPIdentityConflictError(entry.kind)
    }
    if (current.pendingUntil != null && current.pendingUntil <= now) {
      return await this.replaceExpiredInitialClaim(entry, current, ownerOutpoint, expiresAt)
    }
    if (current.pendingUntil == null && consumedOutpoints.includes(current.ownerOutpoint)) {
      return await this.stageSuccessor(entry.id, current, ownerOutpoint, expiresAt)
    }
    throw new UMPIdentityConflictError(entry.kind)
  }

  private async insertInitialClaim(
    entry: ReservationEntry,
    ownerOutpoint: string,
    expiresAt: Date
  ): Promise<ClaimMutation | false> {
    try {
      await this.reservations.insertOne({
        _id: entry.id,
        kind: entry.kind,
        hash: entry.hash,
        ownerOutpoint,
        pendingUntil: expiresAt
      })
      return { id: entry.id, previous: null, claimedField: 'owner' }
    } catch (error) {
      if (this.isDuplicateKey(error)) return false
      throw error
    }
  }

  private async renewExistingClaim(
    current: UMPIdentityReservation,
    ownerOutpoint: string,
    expiresAt: Date
  ): Promise<ClaimMutation | null | false | undefined> {
    if (current.ownerOutpoint === ownerOutpoint && current.pendingOwnerOutpoint == null) {
      if (current.pendingUntil == null) return null
      const previous = await this.reservations.findOneAndUpdate(
        { _id: current._id, ownerOutpoint, pendingUntil: current.pendingUntil },
        { $set: { pendingUntil: expiresAt } },
        { returnDocument: 'before' }
      )
      return previous == null
        ? false
        : { id: current._id, previous, claimedField: 'owner' }
    }
    if (current.pendingOwnerOutpoint !== ownerOutpoint) return undefined
    const previous = await this.reservations.findOneAndUpdate(
      {
        _id: current._id,
        ownerOutpoint: current.ownerOutpoint,
        pendingOwnerOutpoint: ownerOutpoint
      },
      { $set: { pendingOwnerUntil: expiresAt } },
      { returnDocument: 'before' }
    )
    return previous == null
      ? false
      : { id: current._id, previous, claimedField: 'pendingOwner' }
  }

  private async clearExpiredSuccessor(
    current: UMPIdentityReservation,
    now: Date
  ): Promise<boolean> {
    if (current.pendingOwnerUntil == null || current.pendingOwnerUntil > now) return false
    await this.reservations.updateOne(
      {
        _id: current._id,
        ownerOutpoint: current.ownerOutpoint,
        pendingOwnerOutpoint: current.pendingOwnerOutpoint,
        pendingOwnerUntil: current.pendingOwnerUntil
      },
      { $unset: { pendingOwnerOutpoint: '', pendingOwnerUntil: '' } }
    )
    return true
  }

  private async replaceExpiredInitialClaim(
    entry: ReservationEntry,
    current: UMPIdentityReservation,
    ownerOutpoint: string,
    expiresAt: Date
  ): Promise<ClaimMutation | false> {
    const previous = await this.reservations.findOneAndUpdate(
      {
        _id: entry.id,
        ownerOutpoint: current.ownerOutpoint,
        pendingUntil: current.pendingUntil
      },
      {
        $set: {
          kind: entry.kind,
          hash: entry.hash,
          ownerOutpoint,
          pendingUntil: expiresAt
        }
      },
      { returnDocument: 'before' }
    )
    return previous == null ? false : { id: entry.id, previous, claimedField: 'owner' }
  }

  private async stageSuccessor(
    id: string,
    current: UMPIdentityReservation,
    ownerOutpoint: string,
    expiresAt: Date
  ): Promise<ClaimMutation | false> {
    const previous = await this.reservations.findOneAndUpdate(
      {
        _id: id,
        ownerOutpoint: current.ownerOutpoint,
        pendingUntil: { $exists: false },
        pendingOwnerOutpoint: { $exists: false }
      },
      { $set: { pendingOwnerOutpoint: ownerOutpoint, pendingOwnerUntil: expiresAt } },
      { returnDocument: 'before' }
    )
    return previous == null ? false : { id, previous, claimedField: 'pendingOwner' }
  }

  private async rollback(acquired: ClaimMutation[], ownerOutpoint: string): Promise<void> {
    for (const entry of [...acquired].reverse()) {
      if (entry.previous == null) {
        await this.reservations.deleteOne({
          _id: entry.id,
          ownerOutpoint,
          pendingUntil: { $exists: true }
        })
        continue
      }

      const previous = entry.previous
      const set: Record<string, string | Date> = {
        kind: previous.kind,
        hash: previous.hash,
        ownerOutpoint: previous.ownerOutpoint
      }
      const unset: Record<string, ''> = {}
      for (const field of ['pendingUntil', 'pendingOwnerOutpoint', 'pendingOwnerUntil'] as const) {
        const value = previous[field]
        if (value == null) unset[field] = ''
        else set[field] = value
      }
      await this.reservations.updateOne(
        entry.claimedField === 'pendingOwner'
          ? { _id: entry.id, pendingOwnerOutpoint: ownerOutpoint }
          : { _id: entry.id, ownerOutpoint, pendingUntil: { $exists: true } },
        { $set: set, ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }) }
      )
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return error instanceof MongoServerError && error.code === 11000
  }
}
