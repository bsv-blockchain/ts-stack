import { indexedDBReputationStorage } from './IndexedDBReputationStorage.js'

/** Advisory health state. No entry is ever permission to exclude a host. */
export type HostFailureReason = 'timeout' | 'transport' | 'rejected' | 'malformed' | 'invalid'
export interface ReliableReputationEntry {
  updatedAt: number
  cooldownUntil: number
  penalty: number
  reason?: HostFailureReason
}
export interface ReliableReputationStorage {
  get: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
  /** Refresh a synchronous read cache from transactional storage, when needed. */
  load?: (key: string) => Promise<void>
  /** Must serialize coherent read/modify/write across every writer. */
  lock: <T>(name: string, action: () => Promise<T>) => Promise<T>
}
const KEY = 'bsvsdk_overlay_host_reputation_v4'
const TTL = 86400000
const MAX_ENTRIES = 256
const MAX_COOLDOWN = 30000
const reasons = new Set<HostFailureReason>([
  'timeout',
  'transport',
  'rejected',
  'malformed',
  'invalid'
])

function browserStorage(): ReliableReputationStorage | undefined {
  try {
    const factory = globalThis.indexedDB
    return factory == null ? undefined : indexedDBReputationStorage(factory)
  } catch {
    return undefined
  }
}

/** v1-v3 are intentionally not imported: their host-only keys cannot be safely scoped. */
export class ReliableHostReputation {
  private entries: Record<string, ReliableReputationEntry> = {}
  private readonly storage: ReliableReputationStorage | undefined
  constructor(storage?: ReliableReputationStorage | null) {
    this.storage = storage === null ? undefined : (storage ?? browserStorage())
  }

  private scope(network: string, service: string, host: string): string {
    return JSON.stringify([network, service, host])
  }

  private validScope(key: string): boolean {
    try {
      const scope: unknown = JSON.parse(key)
      return Array.isArray(scope) && scope.length === 3 && scope.every(x => typeof x === 'string')
    } catch {
      return false
    }
  }

  private sanitize(input: unknown, now: number): Record<string, ReliableReputationEntry> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
    const entries: Record<string, ReliableReputationEntry> = {}
    for (const [key, value] of Object.entries(input)) {
      if (key.length > 2048 || value === null || typeof value !== 'object') continue
      const e = value as ReliableReputationEntry
      if (![e.updatedAt, e.cooldownUntil, e.penalty].every(Number.isFinite)) continue
      // Clock rollback, implausible future state and TTL expiry all fail open.
      if (e.updatedAt > now || now - e.updatedAt > TTL || e.updatedAt < 0) continue
      if (
        e.penalty < 0 ||
        e.penalty > 64 ||
        e.cooldownUntil < 0 ||
        e.cooldownUntil > e.updatedAt + MAX_COOLDOWN
      )
        continue
      if (e.reason !== undefined && !reasons.has(e.reason)) continue
      if (!this.validScope(key)) continue
      entries[key] = {
        updatedAt: e.updatedAt,
        cooldownUntil: e.cooldownUntil,
        penalty: e.penalty,
        reason: e.reason
      }
    }
    return Object.fromEntries(
      Object.entries(entries)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_ENTRIES)
    )
  }

  private read(now: number): Record<string, ReliableReputationEntry> {
    try {
      const raw = this.storage?.get(KEY)
      if (raw == null || raw.length > 1024 * 1024) return {}
      const envelope = JSON.parse(raw)
      return envelope?.version === 4 ? this.sanitize(envelope.entries, now) : {}
    } catch {
      return {}
    }
  }

  /** Advisory refresh; callers bound this independently of host work. */
  refresh(): Promise<void> {
    return this.storage?.load?.(KEY) ?? Promise.resolve()
  }

  rank(network: string, service: string, hosts: string[]): string[] {
    const now = Date.now()
    this.entries = this.storage === undefined ? this.sanitize(this.entries, now) : this.read(now)
    const score = (host: string): number => {
      const e = this.entries[this.scope(network, service, host)]
      if (e === undefined) return 0
      const cooldownPenalty = e.cooldownUntil > now ? 64 : 0
      return e.penalty * 2 ** (-(now - e.updatedAt) / 60000) + cooldownPenalty
    }
    return [...new Set(hosts)].sort((a, b) => score(a) - score(b))
  }

  /** Sanitized diagnostic snapshot for one explicit scope. */
  snapshot(network: string, service: string, host: string): ReliableReputationEntry | undefined {
    this.rank(network, service, [host])
    const entry = this.entries[this.scope(network, service, host)]
    return entry === undefined ? undefined : { ...entry }
  }

  record(
    network: string,
    service: string,
    host: string,
    reason?: HostFailureReason
  ): Promise<void> {
    const update = (): Promise<void> => {
      const now = Date.now()
      const entries = this.storage === undefined ? this.sanitize(this.entries, now) : this.read(now)
      const key = this.scope(network, service, host)
      const previous = entries[key]
      const weights = { timeout: 1, transport: 2, rejected: 2, malformed: 8, invalid: 16 }
      const decayed =
        previous === undefined ? 0 : previous.penalty * 2 ** (-(now - previous.updatedAt) / 60000)
      const penalty = reason === undefined ? 0 : Math.min(64, decayed + weights[reason])
      entries[key] = {
        updatedAt: now,
        penalty,
        cooldownUntil: reason === undefined ? 0 : now + Math.min(MAX_COOLDOWN, 250 * penalty),
        reason
      }
      this.entries = this.sanitize(entries, now)
      this.storage?.set(KEY, JSON.stringify({ version: 4, entries: this.entries }))
      return Promise.resolve()
    }
    try {
      if (this.storage !== undefined) return this.storage.lock(KEY, update).catch(() => {})
      return update()
    } catch {
      /* Advisory persistence must never break lookup. */
    }
    return Promise.resolve()
  }
}
