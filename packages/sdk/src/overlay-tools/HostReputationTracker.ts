interface HostReputationEntry {
  host: string
  totalSuccesses: number
  totalFailures: number
  consecutiveFailures: number
  avgLatencyMs: number | null
  lastLatencyMs: number | null
  backoffUntil: number
  lastUpdatedAt: number
  lastError?: string
}

export interface RankedHost extends HostReputationEntry {
  score: number
}

const DEFAULT_LATENCY_MS = 1500
const LATENCY_SMOOTHING_FACTOR = 0.25
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000
const FAILURE_PENALTY_MS = 400
const SUCCESS_BONUS_MS = 30
const FAILURE_BACKOFF_GRACE = 2
const STORAGE_KEY = 'bsvsdk_overlay_host_reputation_v3'
const LEGACY_STORAGE_KEY_V2 = 'bsvsdk_overlay_host_reputation_v2'
const LEGACY_STORAGE_KEY_V1 = 'bsvsdk_overlay_host_reputation_v1'
const STORAGE_DEBOUNCE_MS = 50
const MAX_REPUTATION_ENTRIES = 256
const REPUTATION_ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface KeyValueStore {
  get: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

export class HostReputationTracker {
  private readonly stats: Map<string, HostReputationEntry>
  private readonly store: KeyValueStore | undefined
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(store?: KeyValueStore) {
    this.stats = new Map()
    this.store = store ?? this.getLocalStorageAdapter()
    this.loadFromStorage()
  }

  reset(): void {
    this.stats.clear()
    this.scheduleSave()
  }

  recordSuccess(host: string, latencyMs: number): void {
    const entry = this.getOrCreate(host)
    const now = Date.now()
    const safeLatency =
      Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : DEFAULT_LATENCY_MS
    if (entry.avgLatencyMs === null) {
      entry.avgLatencyMs = safeLatency
    } else {
      entry.avgLatencyMs =
        (1 - LATENCY_SMOOTHING_FACTOR) * entry.avgLatencyMs + LATENCY_SMOOTHING_FACTOR * safeLatency
    }
    entry.lastLatencyMs = safeLatency
    entry.totalSuccesses += 1
    entry.consecutiveFailures = 0
    entry.backoffUntil = 0
    entry.lastUpdatedAt = now
    entry.lastError = undefined
    this.scheduleSave()
  }

  recordFailure(host: string, reason?: unknown): void {
    const entry = this.getOrCreate(host)
    const now = Date.now()
    entry.totalFailures += 1
    entry.consecutiveFailures += 1
    let msg: string | undefined
    if (typeof reason === 'string') {
      msg = reason
    } else if (reason instanceof Error) {
      msg = reason.message
    } else {
      msg = undefined
    }
    const immediate =
      typeof msg === 'string' &&
      (msg.includes('ERR_NAME_NOT_RESOLVED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('getaddrinfo') ||
        msg.includes('Failed to fetch'))
    if (immediate && entry.consecutiveFailures < FAILURE_BACKOFF_GRACE + 1) {
      entry.consecutiveFailures = FAILURE_BACKOFF_GRACE + 1
    }
    const penaltyLevel = Math.max(entry.consecutiveFailures - FAILURE_BACKOFF_GRACE, 0)
    if (penaltyLevel === 0) {
      entry.backoffUntil = 0
    } else {
      const backoffDuration = Math.min(
        MAX_BACKOFF_MS,
        BASE_BACKOFF_MS * Math.pow(2, penaltyLevel - 1)
      )
      entry.backoffUntil = now + backoffDuration
    }
    entry.lastUpdatedAt = now
    if (typeof reason === 'string') {
      entry.lastError = reason
    } else if (reason instanceof Error) {
      entry.lastError = reason.message
    } else {
      entry.lastError = undefined
    }
    this.scheduleSave()
  }

  rankHosts(hosts: string[], now: number = Date.now()): RankedHost[] {
    const seen = new Map<string, number>()
    hosts.forEach((host, idx) => {
      if (typeof host !== 'string' || host.length === 0) return
      if (!seen.has(host)) seen.set(host, idx)
    })

    const orderedHosts = Array.from(seen.keys())
    const ranked = orderedHosts.map(host => {
      const entry = this.getOrCreate(host)
      return {
        ...entry,
        score: this.computeScore(entry, now),
        originalOrder: seen.get(host) ?? 0
      }
    })

    ranked.sort((a, b) => {
      const aInBackoff = a.backoffUntil > now
      const bInBackoff = b.backoffUntil > now
      if (aInBackoff !== bInBackoff) return aInBackoff ? 1 : -1
      if (a.score !== b.score) return a.score - b.score
      if (a.totalSuccesses !== b.totalSuccesses) return b.totalSuccesses - a.totalSuccesses
      return (a as any).originalOrder - (b as any).originalOrder
    })

    return ranked.map(({ originalOrder: _originalOrder, ...rest }) => rest)
  }

  snapshot(host: string): HostReputationEntry | undefined {
    const entry = this.stats.get(host)
    return entry == null ? undefined : { ...entry }
  }

  /** Flushes a pending debounced persistence write immediately. */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveToStorage()
  }

  private getStorage(): any {
    try {
      const g: any = typeof globalThis === 'object' ? globalThis : undefined
      if (g?.localStorage == null) return undefined
      return g.localStorage
    } catch {
      return undefined
    }
  }

  private getLocalStorageAdapter(): KeyValueStore | undefined {
    const s = this.getStorage()
    if (s == null) return undefined
    return {
      get: (key: string) => {
        try {
          return s.getItem(key)
        } catch {
          return null
        }
      },
      set: (key: string, value: string) => {
        try {
          s.setItem(key, value)
        } catch {}
      }
    }
  }

  private loadFromStorage(): void {
    const s = this.store
    if (s == null) return
    try {
      let raw = s.get(STORAGE_KEY)
      if (typeof raw !== 'string' || raw.length === 0) {
        const v2 = s.get(LEGACY_STORAGE_KEY_V2)
        if (typeof v2 === 'string' && v2.length > 0) raw = v2
      }
      if (typeof raw !== 'string' || raw.length === 0) {
        const v1 = s.get(LEGACY_STORAGE_KEY_V1)
        if (typeof v1 === 'string' && v1.length > 0) raw = v1
      }
      if (typeof raw !== 'string' || raw.length === 0) return
      const data = JSON.parse(raw)
      if (typeof data !== 'object' || data === null) return
      this.stats.clear()
      for (const k of Object.keys(data)) {
        const v: any = data[k]
        if (v != null && typeof v === 'object') {
          const entry: HostReputationEntry = {
            host: String(v.host ?? k),
            totalSuccesses: Number(v.totalSuccesses ?? 0),
            totalFailures: Number(v.totalFailures ?? 0),
            consecutiveFailures: Number(v.consecutiveFailures ?? 0),
            avgLatencyMs: v.avgLatencyMs == null ? null : Number(v.avgLatencyMs),
            lastLatencyMs: v.lastLatencyMs == null ? null : Number(v.lastLatencyMs),
            backoffUntil: Number(v.backoffUntil ?? 0),
            lastUpdatedAt: Number(v.lastUpdatedAt ?? 0),
            lastError: typeof v.lastError === 'string' ? v.lastError : undefined
          }
          this.stats.set(entry.host, entry)
        }
      }
      this.prune(Date.now())
    } catch {}
  }

  private scheduleSave(): void {
    if (this.store == null || this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveToStorage()
    }, STORAGE_DEBOUNCE_MS)
    const timer = this.saveTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }

  private saveToStorage(): void {
    const s = this.store
    if (s == null) return
    try {
      this.prune(Date.now())
      const obj: Record<string, any> = {}
      for (const [host, entry] of this.stats.entries()) {
        obj[host] = entry
      }
      s.set(STORAGE_KEY, JSON.stringify(obj))
    } catch {}
  }

  private computeScore(entry: HostReputationEntry, now: number): number {
    const latency = entry.avgLatencyMs ?? DEFAULT_LATENCY_MS
    const failurePenalty = entry.consecutiveFailures * FAILURE_PENALTY_MS
    const successBonus = Math.min(entry.totalSuccesses * SUCCESS_BONUS_MS, latency / 2)
    const backoffPenalty = entry.backoffUntil > now ? entry.backoffUntil - now : 0

    return latency + failurePenalty + backoffPenalty - successBonus
  }

  private getOrCreate(host: string): HostReputationEntry {
    let entry = this.stats.get(host)
    if (entry == null) {
      this.prune(Date.now())
      if (this.stats.size >= MAX_REPUTATION_ENTRIES) this.evictOldestEntry()
      entry = {
        host,
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        avgLatencyMs: null,
        lastLatencyMs: null,
        backoffUntil: 0,
        lastUpdatedAt: 0
      }
      this.stats.set(host, entry)
    }
    return entry
  }

  private prune(now: number): void {
    for (const [host, entry] of this.stats) {
      if (entry.lastUpdatedAt > 0 && now - entry.lastUpdatedAt > REPUTATION_ENTRY_TTL_MS) {
        this.stats.delete(host)
      }
    }
    while (this.stats.size > MAX_REPUTATION_ENTRIES) this.evictOldestEntry()
  }

  private evictOldestEntry(): void {
    let oldestHost: string | undefined
    let oldestUpdatedAt = Number.POSITIVE_INFINITY
    for (const [host, entry] of this.stats) {
      if (entry.lastUpdatedAt < oldestUpdatedAt) {
        oldestHost = host
        oldestUpdatedAt = entry.lastUpdatedAt
      }
    }
    if (oldestHost !== undefined) this.stats.delete(oldestHost)
  }
}

const globalTracker = new HostReputationTracker()

export const getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
