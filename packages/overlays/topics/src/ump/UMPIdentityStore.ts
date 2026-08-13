import { Collection, Db, MongoServerError } from 'mongodb'
import type { UMPRecord } from './types.js'

const DEFAULT_PENDING_RESERVATION_TTL_MS = 15 * 60 * 1000

export interface UMPIdentityClaim {
  outpoint: string
  presentationHash: string
  recoveryHash: string
}

export interface UMPIdentityReservationStore {
  reserve: (claim: UMPIdentityClaim, consumedOutpoints: string[]) => Promise<void>
  confirm: (outpoint: string) => Promise<void>
  release: (outpoint: string) => Promise<void>
}

interface UMPIdentityReservation {
  _id: string
  kind: 'presentation' | 'recovery'
  hash: string
  ownerOutpoint: string
  pendingUntil?: Date
}

export class UMPIdentityConflictError extends Error {
  constructor(readonly kind: 'presentation' | 'recovery') {
    super(`The UMP ${kind} hash is already reserved by another unspent outpoint.`)
    this.name = 'UMPIdentityConflictError'
  }
}

function reservationEntries(
  claim: UMPIdentityClaim
): Array<{ id: string; kind: 'presentation' | 'recovery'; hash: string }> {
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

/**
 * Process-local reservation store for direct TopicManager consumers and tests.
 * Production multi-replica overlays should use MongoUMPIdentityStore.
 */
export class InMemoryUMPIdentityStore implements UMPIdentityReservationStore {
  private readonly reservations = new Map<string, string>()

  async reserve(claim: UMPIdentityClaim, consumedOutpoints: string[]): Promise<void> {
    const consumed = new Set(consumedOutpoints)
    const acquired: Array<{ id: string; previous?: string }> = []

    try {
      for (const entry of reservationEntries(claim)) {
        const previous = this.reservations.get(entry.id)
        if (previous !== undefined && previous !== claim.outpoint && !consumed.has(previous)) {
          throw new UMPIdentityConflictError(entry.kind)
        }
        acquired.push({ id: entry.id, ...(previous === undefined ? {} : { previous }) })
        this.reservations.set(entry.id, claim.outpoint)
      }
    } catch (error) {
      const rollbackEntries = [...acquired]
      rollbackEntries.reverse()
      for (const entry of rollbackEntries) {
        if (entry.previous === undefined) this.reservations.delete(entry.id)
        else this.reservations.set(entry.id, entry.previous)
      }
      throw error
    }
  }

  confirm(_outpoint: string): Promise<void> {
    return Promise.resolve()
  }

  async release(outpoint: string): Promise<void> {
    for (const [id, owner] of this.reservations) {
      if (owner === outpoint) this.reservations.delete(id)
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
  }

  async reserve(claim: UMPIdentityClaim, consumedOutpoints: string[]): Promise<void> {
    await this.ensureInitialized()
    const acquired: Array<{
      id: string
      previous: UMPIdentityReservation | null
    }> = []

    try {
      for (const entry of reservationEntries(claim)) {
        const previous = await this.claimOne(entry, claim.outpoint, consumedOutpoints)
        acquired.push({ id: entry.id, previous })
      }
    } catch (error) {
      await this.rollback(acquired, claim.outpoint)
      throw error
    }
  }

  async confirm(outpoint: string): Promise<void> {
    await this.ensureInitialized()
    await this.reservations.updateMany(
      { ownerOutpoint: outpoint },
      { $unset: { pendingUntil: '' } }
    )
  }

  async release(outpoint: string): Promise<void> {
    await this.ensureInitialized()
    await this.reservations.deleteMany({ ownerOutpoint: outpoint })
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize()
    await this.initialization
  }

  private async initialize(): Promise<void> {
    await this.reservations.createIndex(
      { pendingUntil: 1 },
      { expireAfterSeconds: 0, name: 'ump_pending_reservation_expiry' }
    )
    await this.reservations.createIndex({ ownerOutpoint: 1 }, { name: 'ump_reservation_owner' })

    // Preserve the first already-indexed occurrence when upgrading an overlay
    // that predates reservations. Historical ambiguity remains visible to
    // lookup clients and can be resolved with a WAB pin; it is never silently
    // rewritten here.
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
  }

  private async claimOne(
    entry: { id: string; kind: 'presentation' | 'recovery'; hash: string },
    ownerOutpoint: string,
    consumedOutpoints: string[]
  ): Promise<UMPIdentityReservation | null> {
    const now = new Date()
    try {
      return await this.reservations.findOneAndUpdate(
        {
          _id: entry.id,
          $or: [
            { ownerOutpoint },
            { ownerOutpoint: { $in: consumedOutpoints } },
            { pendingUntil: { $lte: now } }
          ]
        },
        {
          $set: {
            kind: entry.kind,
            hash: entry.hash,
            ownerOutpoint,
            pendingUntil: new Date(now.getTime() + this.pendingReservationTtlMs)
          },
          $setOnInsert: { _id: entry.id }
        },
        { upsert: true, returnDocument: 'before' }
      )
    } catch (error) {
      if (this.isDuplicateKey(error)) throw new UMPIdentityConflictError(entry.kind)
      throw error
    }
  }

  private async rollback(
    acquired: Array<{ id: string; previous: UMPIdentityReservation | null }>,
    ownerOutpoint: string
  ): Promise<void> {
    const rollbackEntries = [...acquired]
    rollbackEntries.reverse()
    for (const entry of rollbackEntries) {
      if (entry.previous === null) {
        await this.reservations.deleteOne({ _id: entry.id, ownerOutpoint })
        continue
      }
      const { pendingUntil } = entry.previous
      const previous = {
        kind: entry.previous.kind,
        hash: entry.previous.hash,
        ownerOutpoint: entry.previous.ownerOutpoint
      }
      await this.reservations.updateOne(
        { _id: entry.id, ownerOutpoint },
        pendingUntil === undefined
          ? { $set: previous, $unset: { pendingUntil: '' } }
          : { $set: { ...previous, pendingUntil } }
      )
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return error instanceof MongoServerError && error.code === 11000
  }
}
