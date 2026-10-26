import { utf8ByteLength } from '../primitives/UTF8.js'
import { isPlainRecord } from '../primitives/SafeRecord.js'

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
const MAX_STORED_REPUTATION_BYTES = 1024 * 1024
const MAX_STORED_ENTRY_CANDIDATES = 1024
const MAX_HOST_BYTES = 2048
const MAX_ERROR_BYTES = 8192
const MAX_REPUTATION_COUNTER = 1_000_000_000
const MAX_RECORDED_LATENCY_MS = 24 * 60 * 60 * 1000

interface KeyValueStore {
  get: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maximumBytes
}

function validHost(host: unknown): host is string {
  return boundedString(host, MAX_HOST_BYTES) && host.length > 0
}

function storedCounter(value: unknown, fallback = 0): number | undefined {
  const candidate = value ?? fallback
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < 0 ||
    (candidate as number) > MAX_REPUTATION_COUNTER
  )
    return undefined
  return candidate as number
}

function storedTimestamp(value: unknown, fallback = 0): number | undefined {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) return undefined
  return candidate as number
}

function storedLatency(value: unknown): number | null | undefined {
  if (value == null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_RECORDED_LATENCY_MS
  )
    return undefined
  return value
}

/**
 * Bounded availability/latency hints for ordering an already-authorized host
 * set. Reputation never authenticates a host and must not add a routing target
 * or replace advertisement, transport, or response verification.
 */
export class HostReputationTracker {
  readonly #stats: Map<string, HostReputationEntry>
  readonly #store: KeyValueStore | undefined
  #saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(store?: KeyValueStore) {
    this.#stats = new Map()
    this.#store = store ?? this.#getLocalStorageAdapter()
    this.#loadFromStorage()
  }

  reset(): void {
    this.#stats.clear()
    this.#scheduleSave()
  }

  recordSuccess(host: string, latencyMs: number): void {
    if (!validHost(host)) throw new TypeError('Overlay reputation host is invalid.')
    const entry = this.#getOrCreate(host)
    const now = Date.now()
    const safeLatency =
      Number.isFinite(latencyMs) && latencyMs >= 0
        ? Math.min(latencyMs, MAX_RECORDED_LATENCY_MS)
        : DEFAULT_LATENCY_MS
    if (entry.avgLatencyMs === null) {
      entry.avgLatencyMs = safeLatency
    } else {
      entry.avgLatencyMs =
        (1 - LATENCY_SMOOTHING_FACTOR) * entry.avgLatencyMs + LATENCY_SMOOTHING_FACTOR * safeLatency
    }
    entry.lastLatencyMs = safeLatency
    entry.totalSuccesses = Math.min(entry.totalSuccesses + 1, MAX_REPUTATION_COUNTER)
    entry.consecutiveFailures = 0
    entry.backoffUntil = 0
    entry.lastUpdatedAt = now
    entry.lastError = undefined
    this.#scheduleSave()
  }

  recordFailure(host: string, reason?: unknown): void {
    if (!validHost(host)) throw new TypeError('Overlay reputation host is invalid.')
    const entry = this.#getOrCreate(host)
    const now = Date.now()
    entry.totalFailures = Math.min(entry.totalFailures + 1, MAX_REPUTATION_COUNTER)
    entry.consecutiveFailures = Math.min(entry.consecutiveFailures + 1, MAX_REPUTATION_COUNTER)
    let msg: string | undefined
    try {
      if (typeof reason === 'string') {
        msg = reason
      } else if (reason instanceof Error && typeof reason.message === 'string') {
        msg = reason.message
      }
    } catch {
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
    entry.lastError = boundedString(msg, MAX_ERROR_BYTES) ? msg : undefined
    this.#scheduleSave()
  }

  rankHosts(hosts: string[], now: number = Date.now()): RankedHost[] {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Overlay reputation ranking time is invalid.')
    }
    const seen = new Map<string, number>()
    hosts.forEach((host, idx) => {
      if (!validHost(host)) return
      if (!seen.has(host)) seen.set(host, idx)
    })

    const orderedHosts = Array.from(seen.keys())
    const ranked = orderedHosts.map(host => {
      const entry = this.#getOrCreate(host)
      return {
        ...entry,
        score: this.#computeScore(entry, now),
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
    if (!validHost(host)) return undefined
    const entry = this.#stats.get(host)
    return entry == null ? undefined : { ...entry }
  }

  /** Flushes a pending debounced persistence write immediately. */
  flush(): void {
    if (this.#saveTimer !== null) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
    this.#saveToStorage()
  }

  #getStorage(): any {
    try {
      const g: any = typeof globalThis === 'object' ? globalThis : undefined
      if (g?.localStorage == null) return undefined
      return g.localStorage
    } catch {
      return undefined
    }
  }

  #getLocalStorageAdapter(): KeyValueStore | undefined {
    const s = this.#getStorage()
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

  #readStoredReputation(store: KeyValueStore): string | undefined {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY_V2, LEGACY_STORAGE_KEY_V1]) {
      const raw = store.get(key)
      if (
        typeof raw === 'string' &&
        raw.length > 0 &&
        utf8ByteLength(raw) <= MAX_STORED_REPUTATION_BYTES
      )
        return raw
    }
    return undefined
  }

  #parseStoredEntry(key: string, value: unknown, now: number): HostReputationEntry | undefined {
    if (!validHost(key) || !isPlainRecord(value)) return undefined
    const stored = value
    const host = stored.host ?? key
    const totalSuccesses = storedCounter(stored.totalSuccesses)
    const totalFailures = storedCounter(stored.totalFailures)
    const consecutiveFailures = storedCounter(stored.consecutiveFailures)
    const avgLatencyMs = storedLatency(stored.avgLatencyMs)
    const lastLatencyMs = storedLatency(stored.lastLatencyMs)
    const backoffUntil = storedTimestamp(stored.backoffUntil)
    const lastUpdatedAt = storedTimestamp(stored.lastUpdatedAt)
    if (
      !validHost(host) ||
      host !== key ||
      totalSuccesses === undefined ||
      totalFailures === undefined ||
      consecutiveFailures === undefined ||
      avgLatencyMs === undefined ||
      lastLatencyMs === undefined ||
      backoffUntil === undefined ||
      backoffUntil > now + MAX_BACKOFF_MS ||
      lastUpdatedAt === undefined ||
      lastUpdatedAt > now + MAX_BACKOFF_MS ||
      (stored.lastError !== undefined && !boundedString(stored.lastError, MAX_ERROR_BYTES))
    )
      return undefined
    return {
      host,
      totalSuccesses,
      totalFailures,
      consecutiveFailures,
      avgLatencyMs,
      lastLatencyMs,
      backoffUntil,
      lastUpdatedAt,
      lastError: stored.lastError as string | undefined
    }
  }

  #loadFromStorage(): void {
    const s = this.#store
    if (s == null) return
    try {
      const raw = this.#readStoredReputation(s)
      if (raw === undefined) return
      const data = JSON.parse(raw)
      if (!isPlainRecord(data)) return
      const keys = Object.keys(data)
      if (keys.length > MAX_STORED_ENTRY_CANDIDATES) return
      this.#stats.clear()
      const now = Date.now()
      for (const k of keys) {
        const entry = this.#parseStoredEntry(k, data[k], now)
        if (entry !== undefined) this.#stats.set(entry.host, entry)
      }
      this.#prune(now)
    } catch {}
  }

  #scheduleSave(): void {
    if (this.#store == null || this.#saveTimer !== null) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null
      this.#saveToStorage()
    }, STORAGE_DEBOUNCE_MS)
    const timer = this.#saveTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }

  #saveToStorage(): void {
    const s = this.#store
    if (s == null) return
    try {
      this.#prune(Date.now())
      const obj: Record<string, HostReputationEntry> = Object.create(null)
      for (const [host, entry] of this.#stats.entries()) {
        obj[host] = entry
      }
      s.set(STORAGE_KEY, JSON.stringify(obj))
    } catch {}
  }

  #computeScore(entry: HostReputationEntry, now: number): number {
    const latency = entry.avgLatencyMs ?? DEFAULT_LATENCY_MS
    const failurePenalty = entry.consecutiveFailures * FAILURE_PENALTY_MS
    const successBonus = Math.min(entry.totalSuccesses * SUCCESS_BONUS_MS, latency / 2)
    const backoffPenalty = entry.backoffUntil > now ? entry.backoffUntil - now : 0

    return latency + failurePenalty + backoffPenalty - successBonus
  }

  #getOrCreate(host: string): HostReputationEntry {
    let entry = this.#stats.get(host)
    if (entry == null) {
      this.#prune(Date.now())
      if (this.#stats.size >= MAX_REPUTATION_ENTRIES) this.#evictOldestEntry()
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
      this.#stats.set(host, entry)
    }
    return entry
  }

  #prune(now: number): void {
    for (const [host, entry] of this.#stats) {
      if (entry.lastUpdatedAt > 0 && now - entry.lastUpdatedAt > REPUTATION_ENTRY_TTL_MS) {
        this.#stats.delete(host)
      }
    }
    while (this.#stats.size > MAX_REPUTATION_ENTRIES) this.#evictOldestEntry()
  }

  #evictOldestEntry(): void {
    let oldestHost: string | undefined
    let oldestUpdatedAt = Number.POSITIVE_INFINITY
    for (const [host, entry] of this.#stats) {
      if (entry.lastUpdatedAt < oldestUpdatedAt) {
        oldestHost = host
        oldestUpdatedAt = entry.lastUpdatedAt
      }
    }
    if (oldestHost !== undefined) this.#stats.delete(oldestHost)
  }
}

const globalTracker = new HostReputationTracker()

export const getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
