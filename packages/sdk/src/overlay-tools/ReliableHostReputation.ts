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
  /** Must serialize read/modify/write across every writer (e.g. Web Locks). */
  lock: <T>(name: string, action: () => Promise<T>) => Promise<T>
}
const KEY = 'bsvsdk_overlay_host_reputation_v4'
const TTL = 86400000
const MAX_ENTRIES = 256
const MAX_COOLDOWN = 30000
const reasons: HostFailureReason[] = ['timeout', 'transport', 'rejected', 'malformed', 'invalid']

function browserStorage(): ReliableReputationStorage | undefined {
  try {
    const storage = globalThis.localStorage
    const locks = globalThis.navigator?.locks
    if (storage == null || locks == null) return undefined
    return {
      get: key => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      lock: async (name, action) => await locks.request(name, action)
    }
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
      if (e.reason !== undefined && !reasons.includes(e.reason)) continue
      let scope: unknown
      try {
        scope = JSON.parse(key)
      } catch {
        continue
      }
      if (!Array.isArray(scope) || scope.length !== 3 || !scope.every(x => typeof x === 'string'))
        continue
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

  rank(network: string, service: string, hosts: string[]): string[] {
    const now = Date.now()
    this.entries = this.storage === undefined ? this.sanitize(this.entries, now) : this.read(now)
    const score = (host: string): number => {
      const e = this.entries[this.scope(network, service, host)]
      return e === undefined
        ? 0
        : e.penalty * 2 ** (-(now - e.updatedAt) / 60000) + (e.cooldownUntil > now ? 64 : 0)
    }
    return [...new Set(hosts)].sort((a, b) => score(a) - score(b))
  }

  /** Sanitized diagnostic snapshot for one explicit scope. */
  snapshot(network: string, service: string, host: string): ReliableReputationEntry | undefined {
    this.rank(network, service, [host])
    const entry = this.entries[this.scope(network, service, host)]
    return entry === undefined ? undefined : { ...entry }
  }

  async record(
    network: string,
    service: string,
    host: string,
    reason?: HostFailureReason
  ): Promise<void> {
    const update = async (): Promise<void> => {
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
    }
    try {
      if (this.storage === undefined) await update()
      else await this.storage.lock(KEY, update)
    } catch {
      /* Advisory persistence must never break lookup. */
    }
  }
}
