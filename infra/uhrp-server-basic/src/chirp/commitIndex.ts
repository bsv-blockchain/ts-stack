import type { ChirpCommitRecord } from './contracts'

export interface ChirpCommitMembership {
  record: ChirpCommitRecord
  closure: ReadonlySet<string>
  nodeIdentifiers: ReadonlySet<string>
}

interface CacheEntry {
  membership: ChirpCommitMembership | null
  validUntil: number
  weight: number
}

export class ChirpCommitIndex {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<
    string,
    { generation: number; promise: Promise<ChirpCommitMembership | null> }
  >()
  private totalWeight = 0
  private generation = 0

  constructor(
    private readonly maximumRoots: number,
    private readonly maximumObjects: number,
    private readonly ttlSeconds: number
  ) {}

  async get(
    rootIdentifier: string,
    load: () => Promise<ChirpCommitRecord | null>
  ): Promise<ChirpCommitMembership | null> {
    const now = Math.floor(Date.now() / 1000)
    const cached = this.entries.get(rootIdentifier)
    if (cached != null && cached.validUntil > now) {
      this.entries.delete(rootIdentifier)
      this.entries.set(rootIdentifier, cached)
      return cached.membership
    }
    if (cached != null) this.delete(rootIdentifier)

    const generation = this.generation
    const existing = this.pending.get(rootIdentifier)
    if (existing?.generation === generation) return await existing.promise
    const loading = this.loadAndCache(rootIdentifier, load, now, generation)
    this.pending.set(rootIdentifier, { generation, promise: loading })
    try {
      return await loading
    } finally {
      if (this.pending.get(rootIdentifier)?.promise === loading) {
        this.pending.delete(rootIdentifier)
      }
    }
  }

  set(record: ChirpCommitRecord): ChirpCommitMembership {
    const membership = createMembership(record, this.maximumObjects)
    const now = Math.floor(Date.now() / 1000)
    this.generation += 1
    this.insert(recordRootIdentifier(record), {
      membership,
      validUntil: Math.min(record.expiryTime, now + this.ttlSeconds),
      weight: membership.closure.size
    })
    return membership
  }

  invalidate(rootIdentifier: string): void {
    this.generation += 1
    this.delete(rootIdentifier)
  }

  private async loadAndCache(
    rootIdentifier: string,
    load: () => Promise<ChirpCommitRecord | null>,
    now: number,
    generation: number
  ): Promise<ChirpCommitMembership | null> {
    const record = await load()
    if (record == null) {
      if (this.generation === generation) {
        this.insert(rootIdentifier, {
          membership: null,
          validUntil: now + Math.min(this.ttlSeconds, 2),
          weight: 0
        })
      }
      return null
    }
    if (recordRootIdentifier(record) !== rootIdentifier) {
      throw new Error('CHIRP commit record does not match the requested root identifier.')
    }
    const membership = createMembership(record, this.maximumObjects)
    if (this.generation === generation) {
      this.insert(rootIdentifier, {
        membership,
        validUntil: Math.min(record.expiryTime, now + this.ttlSeconds),
        weight: membership.closure.size
      })
    }
    return membership
  }

  private insert(rootIdentifier: string, entry: CacheEntry): void {
    this.delete(rootIdentifier)
    this.entries.set(rootIdentifier, entry)
    this.totalWeight += entry.weight
    while (this.entries.size > this.maximumRoots || this.totalWeight > this.maximumObjects) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest == null) break
      this.delete(oldest)
    }
  }

  private delete(rootIdentifier: string): void {
    const existing = this.entries.get(rootIdentifier)
    if (existing == null) return
    this.totalWeight -= existing.weight
    this.entries.delete(rootIdentifier)
  }
}

function createMembership(
  record: ChirpCommitRecord,
  maximumObjects: number
): ChirpCommitMembership {
  if (
    !Array.isArray(record.closure) ||
    record.closure.length > maximumObjects ||
    !Array.isArray(record.nodeIdentifiers) ||
    record.nodeIdentifiers.length > maximumObjects
  ) {
    throw new Error('CHIRP commit membership exceeds the configured index limit.')
  }
  return {
    record,
    closure: new Set(record.closure),
    nodeIdentifiers: new Set(record.nodeIdentifiers)
  }
}

function recordRootIdentifier(record: ChirpCommitRecord): string {
  if (typeof record.rootIdentifier !== 'string' || record.rootIdentifier === '') {
    throw new Error('CHIRP commit record has no root identifier.')
  }
  return record.rootIdentifier
}
