interface HostReputationEntry {
  host: string
  totalSuccesses: number
  totalFailures: number
  consecutiveFailures: number
  avgLatencyMs: number | null
  lastLatencyMs: number | null
  /**
   * EMA of completeness ratio (this host's unique outputs / peer max unique outputs)
   * across recent queries. `null` until at least one recordAnswer call. A host that
   * consistently returns the largest result set converges to 1.0; one that returns
   * only a fraction converges down toward that fraction.
   */
  avgCompleteness: number | null
  backoffUntil: number
  lastUpdatedAt: number
  lastError?: string
}

export interface RankedHost extends HostReputationEntry {
  score: number
}

const DEFAULT_LATENCY_MS = 1500
const LATENCY_SMOOTHING_FACTOR = 0.25
const COMPLETENESS_SMOOTHING_FACTOR = 0.3
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000
const FAILURE_PENALTY_MS = 400
const SUCCESS_BONUS_MS = 30
const FAILURE_BACKOFF_GRACE = 2
/**
 * Latency in ms beyond which we stop forgiving a slow host even if it returns more
 * complete data. Mirrors the "ten times as long is unacceptable" rule.
 */
const ACCURACY_LATENCY_TOLERANCE_MS = 10_000
/** Score weight: how much completeness shifts the score (in latency-equivalent ms). */
const COMPLETENESS_SCORE_WEIGHT_MS = 1200
/**
 * Minimum completeness-EMA advantage an in-flight host must hold over the best
 * already-answered host before a query delays its first emission to wait for it.
 * Wide enough to ignore EMA noise between comparably-complete hosts; the
 * production failure mode this targets separates by far more (~1.0 vs ~0.4).
 */
const HOLD_COMPLETENESS_MARGIN = 0.15
const STORAGE_KEY = 'bsvsdk_overlay_host_reputation_v2'
const LEGACY_STORAGE_KEY_V1 = 'bsvsdk_overlay_host_reputation_v1'

interface KeyValueStore {
  get: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

export class HostReputationTracker {
  private readonly stats: Map<string, HostReputationEntry>
  private readonly store: KeyValueStore | undefined

  constructor (store?: KeyValueStore) {
    this.stats = new Map()
    this.store = store ?? this.getLocalStorageAdapter()
    this.loadFromStorage()
  }

  reset (): void {
    this.stats.clear()
  }

  recordSuccess (host: string, latencyMs: number): void {
    const entry = this.getOrCreate(host)
    const now = Date.now()
    const safeLatency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : DEFAULT_LATENCY_MS
    if (entry.avgLatencyMs === null) {
      entry.avgLatencyMs = safeLatency
    } else {
      entry.avgLatencyMs =
        (1 - LATENCY_SMOOTHING_FACTOR) * entry.avgLatencyMs +
        LATENCY_SMOOTHING_FACTOR * safeLatency
    }
    entry.lastLatencyMs = safeLatency
    entry.totalSuccesses += 1
    entry.consecutiveFailures = 0
    entry.backoffUntil = 0
    entry.lastUpdatedAt = now
    entry.lastError = undefined
    this.saveToStorage()
  }

  /**
   * Records the completeness of an answer relative to peers from the same query.
   * Updates only the completeness EMA — latency and success counts are owned by
   * `recordSuccess` so call sites that fire both don't double-count.
   *
   * `peerMaxUniqueOutputCount` of 0 (nobody returned anything) is treated as neutral —
   * no signal about who is more accurate, so the EMA is not touched.
   */
  recordAnswer (
    host: string,
    uniqueOutputCount: number,
    peerMaxUniqueOutputCount: number
  ): void {
    if (peerMaxUniqueOutputCount <= 0) return
    const entry = this.getOrCreate(host)
    const ratio = Math.min(1, Math.max(0, uniqueOutputCount / peerMaxUniqueOutputCount))
    if (entry.avgCompleteness === null) {
      entry.avgCompleteness = ratio
    } else {
      entry.avgCompleteness =
        (1 - COMPLETENESS_SMOOTHING_FACTOR) * entry.avgCompleteness +
        COMPLETENESS_SMOOTHING_FACTOR * ratio
    }
    this.saveToStorage()
  }

  /**
   * True when waiting for `host` could materially improve on `baselineCompleteness`
   * (the best completeness among hosts that have already answered the current
   * query) and the host is not so slow that waiting is unreasonable. Used by the
   * resolver to decide whether a query's first emission should be held until
   * this host settles.
   *
   * A host with no completeness track record is treated per `awaitUnknown`:
   * - `false` (query$ default): never wait — streaming consumers get partials
   *   immediately and cold-start behavior stays latency-first.
   * - `true` (query() default): treat the unobserved host as potentially fully
   *   complete (optimistic 1.0), so a cold-start blocking query waits for every
   *   unknown host to settle — and merges the best of what arrives — instead of
   *   racing to the first answer. Note 1.0 only clears the margin when
   *   `baselineCompleteness` is itself materially below complete: once some
   *   answered host is near-complete, unknowns are not worth waiting for.
   */
  worthWaitingFor (host: string, baselineCompleteness: number, awaitUnknown: boolean = false): boolean {
    const entry = this.stats.get(host)
    const completeness = entry?.avgCompleteness ?? null
    if (completeness === null && !awaitUnknown) return false
    if ((entry?.avgLatencyMs ?? DEFAULT_LATENCY_MS) > ACCURACY_LATENCY_TOLERANCE_MS) return false
    const potential = completeness ?? 1
    return potential >= baselineCompleteness + HOLD_COMPLETENESS_MARGIN
  }

  recordFailure (host: string, reason?: unknown): void {
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
    this.saveToStorage()
  }

  rankHosts (hosts: string[], now: number = Date.now()): RankedHost[] {
    const seen = new Map<string, number>()
    hosts.forEach((host, idx) => {
      if (typeof host !== 'string' || host.length === 0) return
      if (!seen.has(host)) seen.set(host, idx)
    })

    const orderedHosts = Array.from(seen.keys())
    const ranked = orderedHosts.map((host) => {
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

    return ranked.map(({ originalOrder, ...rest }) => rest)
  }

  snapshot (host: string): HostReputationEntry | undefined {
    const entry = this.stats.get(host)
    return entry == null ? undefined : { ...entry }
  }

  private getStorage (): any {
    try {
      const g: any = typeof globalThis === 'object' ? globalThis : undefined
      if (g?.localStorage == null) return undefined
      return g.localStorage
    } catch {
      return undefined
    }
  }

  private getLocalStorageAdapter (): KeyValueStore | undefined {
    const s = this.getStorage()
    if (s == null) return undefined
    return {
      get: (key: string) => {
        try { return s.getItem(key) } catch { return null }
      },
      set: (key: string, value: string) => {
        try { s.setItem(key, value) } catch { }
      }
    }
  }

  private loadFromStorage (): void {
    const s = this.store
    if (s == null) return
    try {
      let raw = s.get(STORAGE_KEY)
      // Migrate v1 → v2: legacy entries get a neutral avgCompleteness so they
      // neither help nor hurt until we observe a real query.
      if (typeof raw !== 'string' || raw.length === 0) {
        const legacy = s.get(LEGACY_STORAGE_KEY_V1)
        if (typeof legacy === 'string' && legacy.length > 0) raw = legacy
      }
      if (typeof raw !== 'string' || raw.length === 0) return
      const data = JSON.parse(raw)
      if (typeof data !== 'object' || data === null) return
      this.stats.clear()
      for (const k of Object.keys(data)) {
        const v: any = (data)[k]
        if (v != null && typeof v === 'object') {
          const entry: HostReputationEntry = {
            host: String(v.host ?? k),
            totalSuccesses: Number(v.totalSuccesses ?? 0),
            totalFailures: Number(v.totalFailures ?? 0),
            consecutiveFailures: Number(v.consecutiveFailures ?? 0),
            avgLatencyMs: v.avgLatencyMs == null ? null : Number(v.avgLatencyMs),
            lastLatencyMs: v.lastLatencyMs == null ? null : Number(v.lastLatencyMs),
            avgCompleteness: v.avgCompleteness == null ? null : Number(v.avgCompleteness),
            backoffUntil: Number(v.backoffUntil ?? 0),
            lastUpdatedAt: Number(v.lastUpdatedAt ?? 0),
            lastError: typeof v.lastError === 'string' ? v.lastError : undefined
          }
          this.stats.set(entry.host, entry)
        }
      }
    } catch {}
  }

  private saveToStorage (): void {
    const s = this.store
    if (s == null) return
    try {
      const obj: Record<string, any> = {}
      for (const [host, entry] of this.stats.entries()) {
        obj[host] = entry
      }
      s.set(STORAGE_KEY, JSON.stringify(obj))
    } catch {}
  }

  private computeScore (entry: HostReputationEntry, now: number): number {
    const latency = entry.avgLatencyMs ?? DEFAULT_LATENCY_MS
    const failurePenalty = entry.consecutiveFailures * FAILURE_PENALTY_MS
    const successBonus = Math.min(entry.totalSuccesses * SUCCESS_BONUS_MS, latency / 2)
    const backoffPenalty = entry.backoffUntil > now ? entry.backoffUntil - now : 0

    // Completeness adjustment: a host that consistently returns the largest result
    // set gets a bonus (lower score = better rank); one that returns less than peers
    // gets a penalty. Only applies once we've observed completeness, and we stop
    // rewarding hosts that exceed the latency tolerance.
    let completenessAdjustment = 0
    if (entry.avgCompleteness !== null && latency <= ACCURACY_LATENCY_TOLERANCE_MS) {
      // ratio of 1.0 → -COMPLETENESS_SCORE_WEIGHT_MS (better)
      // ratio of 0.5 → 0
      // ratio of 0.0 → +COMPLETENESS_SCORE_WEIGHT_MS (worse)
      completenessAdjustment = (0.5 - entry.avgCompleteness) * 2 * COMPLETENESS_SCORE_WEIGHT_MS
    }

    return latency + failurePenalty + backoffPenalty - successBonus + completenessAdjustment
  }

  private getOrCreate (host: string): HostReputationEntry {
    let entry = this.stats.get(host)
    if (entry == null) {
      entry = {
        host,
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveFailures: 0,
        avgLatencyMs: null,
        lastLatencyMs: null,
        avgCompleteness: null,
        backoffUntil: 0,
        lastUpdatedAt: 0
      }
      this.stats.set(host, entry)
    }
    return entry
  }
}

const globalTracker = new HostReputationTracker()

export const getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
