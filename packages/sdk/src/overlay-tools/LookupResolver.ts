import { Transaction } from '../transaction/index.js'
import { Beef } from '../transaction/Beef.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import * as Utils from '../primitives/utils.js'
import { getOverlayHostReputationTracker, HostReputationTracker } from './HostReputationTracker.js'
import { Telemetry, TelemetryConfig } from '../telemetry/Telemetry.js'

const defaultFetch: typeof fetch =
  typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : fetch

/**
 * The question asked to the Overlay Services Engine when a consumer of state wishes to look up information.
 */
export interface LookupQuestion {
  /**
   * The identifier for a Lookup Service which the person asking the question wishes to use.
   */
  service: string

  /**
   * The query which will be forwarded to the Lookup Service.
   * Its type depends on that prescribed by the Lookup Service employed.
   */
  query: unknown
}

/** An aggregatable output-list answer returned by the resolver. */
export type LookupAnswer = {
  type: 'output-list'
  outputs: Array<{
    beef: number[]
    outputIndex: number
    context?: number[]
    /** Optional txid hint. When present, consumers can skip re-parsing beef to derive the txid. */
    txid?: string
  }>
}

/** A valid non-aggregatable response returned by a lookup service. */
export interface LookupFreeformAnswer {
  type: 'freeform'
  result: unknown
}

/** Responses a facilitator may return before the resolver aggregates them. */
export type LookupFacilitatorAnswer = LookupAnswer | LookupFreeformAnswer

/**
 * Per-call options for {@link LookupResolver.query} and {@link LookupResolver.query$}.
 * All optional; defaults preserve prior behavior.
 */
export interface LookupQueryOptions {
  /**
   * Override the grace window (ms) between the first valid response and the resolution of the query.
   * Late responders arriving within this window are merged into the result. Default 80 ms.
   * Raise for identity-style paths (e.g. ~300 ms) where divergence between hosts matters.
   */
  graceMs?: number
  /**
   * Soft timeout (ms). When set:
   *  - `query()` resolves with whatever has arrived as soon as any host answers, or after this timeout.
   *  - `query$()` emits a (possibly empty) snapshot after this timeout if no host has answered yet,
   *    then continues yielding late-host enrichments until the iterator is broken or final emission.
   */
  softTimeoutMs?: number
  /**
   * Fired when a SLAP-advertised host fails (network error, timeout, malformed
   * response). The resolver itself does not email or escalate — downstream
   * consumers (e.g. overlay-express) wire this up to the BSVA notification API
   * to let the originating overlay operator know about a stale advertisement.
   */
  onUnreachableHost?: (info: UnreachableHostInfo) => void | Promise<void>
  /**
   * Minimum interval between unreachable notifications for the same host and
   * service. Defaults to 60 seconds to prevent notification storms. Set to 0
   * to disable deduplication.
   */
  unreachableHostNotificationCooldownMs?: number
  /**
   * Compatibility alias for `waitForAllHosts`. Prefer `waitForAllHosts` in new
   * code. `waitForAllHosts` takes precedence when both are supplied.
   */
  holdForUnknownHosts?: boolean
  /**
   * Wait for every queried host to settle before the first emission. This is
   * the default for `query()` because generic output cardinality is not proof
   * of freshness or authority. It defaults to `false` for progressive
   * `query$()` consumers. `holdForUnknownHosts` remains as a compatibility
   * alias; `waitForAllHosts` takes precedence when both are supplied.
   */
  waitForAllHosts?: boolean
  /** Correlates resolver and downstream wallet telemetry without logging the query payload. */
  correlationId?: string
}

/** Info supplied to onUnreachableHost callbacks. */
export interface UnreachableHostInfo {
  /** Host URL that failed. */
  host: string
  /** Lookup service that was being queried when the failure occurred. */
  service: string
  /** Error message from the facilitator. */
  error: string
  /** SLAP tracker URL that advertised this host, if known. */
  advertisedBy?: string
}

/**
 * One emission from {@link LookupResolver.query$}. Carries the cumulative output set discovered so far
 * plus a small envelope describing progress across hosts. Callers can render fast on the first emission
 * and refine in place as more hosts answer.
 */
export interface LookupAnswerProgress {
  type: 'output-list'
  outputs: Array<{ beef: number[]; outputIndex: number; context?: number[]; txid?: string }>
  /** Parallel array of resolved tx ids for each output (same index as `outputs`). */
  txIds: string[]
  /** True only for the final emission, after every in-flight host has settled. */
  isFinal: boolean
  /** Number of ranked hosts that were queried. */
  hostCount: number
  /** Number of hosts that have settled (success / fail / timeout). */
  completedHosts: number
  /** Hosts that returned a structurally valid output-list response. */
  successfulHosts: number
  /** Successful hosts whose output list was empty. */
  emptyHosts: number
  /** Hosts that failed due to availability, timeout, or malformed responses. */
  failedHosts: number
  /** Hosts that rejected this query semantically (for example, HTTP 400). */
  rejectedHosts: number
  /** Hosts that returned a valid but non-aggregatable freeform response. */
  freeformHosts: number
  /** Correlation id used for privacy-safe distributed diagnostics. */
  correlationId?: string
}

/** A lookup answer together with the host settlement evidence behind it. */
export interface LookupResolution {
  answer: LookupAnswer
  progress: LookupAnswerProgress
}

/** Default SLAP trackers */
export const DEFAULT_SLAP_TRACKERS: string[] = [
  // BSVA clusters
  'https://overlay-us-1.bsvb.tech',
  'https://overlay-eu-1.bsvb.tech',
  'https://overlay-ap-1.bsvb.tech',

  // Babbage primary overlay service
  'https://users.bapp.dev'

  // NOTE: Other entities may submit pull requests to the library if they maintain SLAP overlay services.
  // Additional trackers run by different entities contribute to greater network resiliency.
  // It also generally doesn't hurt to have more trackers in this list.

  // DISCLAIMER:
  // Trackers known to host invalid or illegal records will be removed at the discretion of the BSV Association.
]

/** Default testnet SLAP trackers */
export const DEFAULT_TESTNET_SLAP_TRACKERS: string[] = [
  // Babbage primary testnet overlay service
  'https://testnet-users.bapp.dev'
]

const MAX_TRACKER_WAIT_TIME = 5000
const DEFAULT_LOOKUP_TIMEOUT = 2000
const DEFAULT_UNREACHABLE_NOTIFICATION_COOLDOWN_MS = 60_000
const MAX_NOTIFICATION_DEDUP_ENTRIES = 512

export type LookupHTTPErrorKind = 'semantic' | 'availability'

/** An HTTP failure with enough classification for reputation handling. */
export class LookupHTTPError extends Error {
  readonly status: number
  readonly kind: LookupHTTPErrorKind

  constructor(status: number, kind: LookupHTTPErrorKind, statusText?: string) {
    const detail =
      typeof statusText === 'string' && statusText.trim().length > 0 ? ` ${statusText.trim()}` : ''
    super(`Failed to facilitate lookup (HTTP ${status}${detail})`)
    this.name = 'LookupHTTPError'
    this.status = status
    this.kind = kind
  }
}

/** True when an HTTP response rejects this query without proving host outage. */
function isSemanticLookupRejection(err: unknown): boolean {
  return err instanceof LookupHTTPError && err.kind === 'semantic'
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

function isLookupOutput(value: unknown): value is LookupAnswer['outputs'][number] {
  if (typeof value !== 'object' || value === null) return false
  const output = value as Record<string, unknown>
  if (!isByteArray(output.beef) || output.beef.length === 0) return false
  if (!Number.isInteger(output.outputIndex) || (output.outputIndex as number) < 0) return false
  if (output.context !== undefined && !isByteArray(output.context)) return false
  if (
    output.txid !== undefined &&
    (typeof output.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(output.txid))
  )
    return false
  return true
}

function isOutputListAnswer(value: unknown): value is LookupAnswer {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  return (
    answer.type === 'output-list' &&
    Array.isArray(answer.outputs) &&
    answer.outputs.every(isLookupOutput)
  )
}

function isFreeformAnswer(value: unknown): value is LookupFreeformAnswer {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  return answer.type === 'freeform' && Object.prototype.hasOwnProperty.call(answer, 'result')
}

/** A wall-clock deadline that rejects after `timeoutMs`, optionally aborting a controller. */
interface Deadline {
  /** Rejects with `Error('Request timed out')` once the timer fires. */
  promise: Promise<never>
  /** Clears the underlying timer. Safe to call after the timer has already fired. */
  cancel: () => void
  /** Returns true once the timer has fired. */
  didTimeOut: () => boolean
}

function createDeadline(timeoutMs: number, controller?: AbortController): Deadline {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true
      try {
        controller?.abort()
      } catch {
        /* noop */
      }
      reject(new Error('Request timed out'))
    }, timeoutMs)
  })
  return {
    promise,
    cancel: () => {
      if (timer !== null) clearTimeout(timer)
    },
    didTimeOut: () => expired
  }
}

function normalizeLookupError(err: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error('Request timed out')
  if ((err as { name?: string })?.name === 'AbortError') return new Error('Request timed out')
  if (err instanceof Error) return err
  return new Error(Utils.toSafeString(err, 'Unknown error'))
}

/**
 * Returns true when the given Content-Type header value represents
 * `application/octet-stream`, ignoring case and any media-type parameters
 * (e.g. `; charset=utf-8`).
 */
function isOctetStream(contentType: string | null): boolean {
  if (typeof contentType !== 'string') return false
  const baseType = contentType.split(';', 1)[0].trim().toLowerCase()
  return baseType === 'application/octet-stream'
}

/** Internal cache options. Kept optional to preserve drop-in compatibility. */
interface CacheOptions {
  /** How long (ms) a hosts entry is considered fresh. Default 5 minutes. */
  hostsTtlMs?: number
  /** How many distinct services’ hosts to cache before evicting. Default 128. */
  hostsMaxEntries?: number
  /** How long (ms) to keep txId memoization. Default 10 minutes. */
  txMemoTtlMs?: number
}

/** Configuration options for the Lookup resolver. */
export interface LookupResolverConfig {
  /**
   * The network preset to use, unless other options override it.
   * - mainnet: use mainnet SLAP trackers and HTTPS facilitator
   * - testnet: use testnet SLAP trackers and HTTPS facilitator
   * - local: directly query from localhost:8080 and a facilitator that permits plain HTTP
   */
  networkPreset?: 'mainnet' | 'testnet' | 'local'
  /** The facilitator used to make requests to Overlay Services hosts. */
  facilitator?: OverlayLookupFacilitator
  /** The list of SLAP trackers queried to resolve Overlay Services hosts for a given lookup service. */
  slapTrackers?: string[]
  /** Map of lookup service names to arrays of hosts to use in place of resolving via SLAP. */
  hostOverrides?: Record<string, string[]>
  /** Map of lookup service names to arrays of hosts to use in addition to resolving via SLAP. */
  additionalHosts?: Record<string, string[]>
  /** Optional cache tuning. */
  cache?: CacheOptions
  /** Optional storage for host reputation data. */
  reputationStorage?:
    | 'localStorage'
    | { get: (key: string) => string | null | undefined; set: (key: string, value: string) => void }
  /** Optional privacy-bounded telemetry sink. Query payloads are never emitted. */
  telemetry?: TelemetryConfig
}

/** Facilitates lookups to URLs that return answers. */
export interface OverlayLookupFacilitator {
  /**
   * Returns a lookup answer for a lookup question
   * @param url - Overlay Service URL to send the lookup question to.
   * @param question - Lookup question to find an answer to.
   * @param timeout - Specifics how long to wait for a lookup answer in milliseconds.
   * @returns
   */
  lookup: (
    url: string,
    question: LookupQuestion,
    timeout?: number
  ) => Promise<LookupFacilitatorAnswer>
}

export class HTTPSOverlayLookupFacilitator implements OverlayLookupFacilitator {
  fetchClient: typeof fetch
  allowHTTP: boolean

  constructor(httpClient = defaultFetch, allowHTTP: boolean = false) {
    if (typeof httpClient !== 'function') {
      throw new TypeError(
        'HTTPSOverlayLookupFacilitator requires a fetch implementation. ' +
          'In environments without fetch, provide a polyfill or custom implementation.'
      )
    }
    this.fetchClient = httpClient
    this.allowHTTP = allowHTTP
  }

  async lookup(
    url: string,
    question: LookupQuestion,
    timeout: number = 2000
  ): Promise<LookupFacilitatorAnswer> {
    if (!url.startsWith('https:') && !this.allowHTTP) {
      throw new Error('HTTPS facilitator can only use URLs that start with "https:"')
    }

    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
    const deadline = createDeadline(timeout, controller)

    // Hard wall-clock deadline: in some environments (e.g. browser/Electron CORS
    // failures) the underlying fetch can stall without ever settling, and the
    // AbortController signal alone is insufficient to make the returned promise
    // resolve or reject. Race the fetch against a setTimeout-backed reject so
    // the consumer-facing promise always settles within `timeout` ms.
    const fetchPromise = this.performLookupRequest(url, question, controller?.signal)
    // Swallow background rejection if the deadline wins first.
    fetchPromise.catch(() => {
      /* noop */
    })

    try {
      return await Promise.race([fetchPromise, deadline.promise])
    } catch (e) {
      throw normalizeLookupError(e, deadline.didTimeOut())
    } finally {
      deadline.cancel()
    }
  }

  private async performLookupRequest(
    url: string,
    question: LookupQuestion,
    signal: AbortSignal | undefined
  ): Promise<LookupFacilitatorAnswer> {
    const fco: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aggregation': 'yes'
      },
      body: JSON.stringify({ service: question.service, query: question.query }),
      signal
    }
    const response: Response = await this.fetchClient(`${url}/lookup`, fco)
    if (!response.ok) {
      // 408/429 are availability/backpressure signals. Other 4xx responses
      // reject this request but do not prove that the host is unavailable, so
      // they remain distinguishable and neutral for availability reputation.
      const kind: LookupHTTPErrorKind =
        response.status < 400 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
          ? 'availability'
          : 'semantic'
      throw new LookupHTTPError(response.status, kind, response.statusText)
    }
    if (isOctetStream(response.headers.get('content-type'))) {
      return await this.parseOctetStreamLookup(response)
    }
    return await response.json()
  }

  /** Parse the aggregated octet-stream lookup response into an output-list LookupAnswer. */
  private async parseOctetStreamLookup(response: Response): Promise<LookupAnswer> {
    const payload = await response.arrayBuffer()
    const r = new Utils.Reader([...new Uint8Array(payload)])
    const nOutpoints = r.readVarIntNum()
    const outpoints: Array<{ txid: string; outputIndex: number; context?: number[] }> = []
    for (let i = 0; i < nOutpoints; i++) {
      const txid = Utils.toHex(r.read(32))
      const outputIndex = r.readVarIntNum()
      const contextLength = r.readVarIntNum()
      const context = contextLength > 0 ? r.read(contextLength) : undefined
      outpoints.push({ txid, outputIndex, context })
    }
    const beef = r.read()
    const beefObj = Beef.fromBinary(beef)
    const outputs = await this.extractAtomicOutputs(outpoints, beefObj)
    return { type: 'output-list', outputs }
  }

  /** Memoize per-txid atomic BEEF extraction, yielding to the event loop between outputs. */
  private async extractAtomicOutputs(
    outpoints: Array<{ txid: string; outputIndex: number; context?: number[] }>,
    beefObj: Beef
  ): Promise<Array<{ outputIndex: number; context?: number[]; beef: number[]; txid: string }>> {
    const beefByTxid = new Map<string, number[]>()
    const outputs: Array<{
      outputIndex: number
      context?: number[]
      beef: number[]
      txid: string
    }> = Array.from({ length: outpoints.length })
    for (let idx = 0; idx < outpoints.length; idx++) {
      const x = outpoints[idx]
      let beefBytes = beefByTxid.get(x.txid)
      if (beefBytes === undefined) {
        beefBytes = beefObj.toBinaryAtomic(x.txid)
        beefByTxid.set(x.txid, beefBytes)
      }
      outputs[idx] = {
        outputIndex: x.outputIndex,
        context: x.context,
        beef: beefBytes,
        txid: x.txid
      }
      // Yield to event loop so UI animations and other JS don't starve.
      if (idx > 0 && idx < outpoints.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    return outputs
  }
}

/**
 * Represents a Lookup Resolver.
 */
export default class LookupResolver {
  private readonly facilitator: OverlayLookupFacilitator
  private readonly slapTrackers: string[]
  private readonly hostOverrides: Record<string, string[]>
  private readonly additionalHosts: Record<string, string[]>
  private readonly networkPreset: 'mainnet' | 'testnet' | 'local'
  private readonly hostReputation: HostReputationTracker
  private readonly telemetry: Telemetry

  // ---- Caches / memoization ----
  private readonly hostsCache: Map<string, { hosts: string[]; expiresAt: number }>
  private readonly hostsInFlight: Map<string, Promise<string[]>>
  private readonly hostsTtlMs: number
  private readonly hostsMaxEntries: number

  private readonly txMemo: Map<string, { txId: string; expiresAt: number }>
  private readonly txMemoTtlMs: number

  /**
   * Records which SLAP tracker most recently advertised each host. Used to
   * attach `advertisedBy` to onUnreachableHost callbacks so downstream
   * notification consumers know which tracker has a stale advertisement.
   */
  private readonly advertisedBy: Map<string, string>
  private readonly lastUnreachableNotificationAt: Map<string, number>

  constructor(config: LookupResolverConfig = {}) {
    this.networkPreset = config.networkPreset ?? 'mainnet'
    this.facilitator =
      config.facilitator ??
      new HTTPSOverlayLookupFacilitator(undefined, this.networkPreset === 'local')
    this.slapTrackers =
      config.slapTrackers ??
      (this.networkPreset === 'mainnet' ? DEFAULT_SLAP_TRACKERS : DEFAULT_TESTNET_SLAP_TRACKERS)
    const hostOverrides = config.hostOverrides ?? {}
    this.assertValidOverrideServices(hostOverrides)
    this.hostOverrides = hostOverrides
    this.additionalHosts = config.additionalHosts ?? {}
    this.telemetry = new Telemetry(config.telemetry)

    const rs = config.reputationStorage
    if (rs === 'localStorage') {
      this.hostReputation = new HostReputationTracker()
    } else if (
      typeof rs === 'object' &&
      rs !== null &&
      typeof rs.get === 'function' &&
      typeof rs.set === 'function'
    ) {
      this.hostReputation = new HostReputationTracker(rs)
    } else {
      this.hostReputation = getOverlayHostReputationTracker()
    }

    // cache tuning
    this.hostsTtlMs = config.cache?.hostsTtlMs ?? 5 * 60 * 1000 // 5 min
    this.hostsMaxEntries = config.cache?.hostsMaxEntries ?? 128
    this.txMemoTtlMs = config.cache?.txMemoTtlMs ?? 10 * 60 * 1000 // 10 min

    this.hostsCache = new Map()
    this.hostsInFlight = new Map()
    this.txMemo = new Map()
    this.advertisedBy = new Map()
    this.lastUnreachableNotificationAt = new Map()
  }

  /**
   * Given a LookupQuestion, returns a LookupAnswer. Aggregates across multiple services and supports resiliency.
   *
   * Optional `options.graceMs` overrides the per-call grace window (default 80 ms).
   * Optional `options.softTimeoutMs` resolves the query early with whatever has arrived once any host has
   * answered (or with an empty result if no host has answered by `softTimeoutMs`).
   */
  async query(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupAnswer> {
    return (await this.queryDetailed(question, timeout, options)).answer
  }

  /**
   * Performs a lookup and returns both its answer and the host settlement
   * evidence required by security-sensitive consumers to distinguish an
   * authoritative empty result from an availability failure.
   */
  async queryDetailed(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupResolution> {
    // A generic resolver cannot prove that a larger answer is fresher or more
    // authoritative. The blocking API therefore waits for every bounded host
    // settlement by default and merges the valid outputs. Callers that prefer
    // first-response latency can opt out with waitForAllHosts: false; callers
    // wanting progressive enrichment use query$().
    // Take only the first emission, then explicitly close the iterator so the
    // generator's `finally` block runs and clears any outstanding timers.
    const iter = this.query$(question, timeout, {
      ...options,
      waitForAllHosts: options?.waitForAllHosts ?? options?.holdForUnknownHosts ?? true
    })[Symbol.asyncIterator]()
    let last: LookupAnswerProgress | null = null
    try {
      const { value, done } = await iter.next()
      if (done !== true && value != null) last = value
    } finally {
      await iter.return?.(undefined)
    }
    return {
      answer: {
        type: 'output-list',
        outputs: last?.outputs ?? []
      },
      progress: last ?? {
        type: 'output-list',
        outputs: [],
        txIds: [],
        isFinal: true,
        hostCount: 0,
        completedHosts: 0,
        successfulHosts: 0,
        emptyHosts: 0,
        failedHosts: 0,
        rejectedHosts: 0,
        freeformHosts: 0,
        ...(options?.correlationId !== undefined ? { correlationId: options.correlationId } : {})
      }
    }
  }

  /**
   * Iterable form of {@link query}. Emits partial results as hosts answer.
   *
   * Emission order:
   *  - First emission: after the grace window expires (or as soon as the soft timeout elapses), containing
   *    every output gathered from hosts that answered by then.
   *  - Subsequent emissions: re-emitted whenever a late host returns extra outputs that weren't in earlier
   *    emissions. Each emission contains the cumulative `outputs` set.
   *  - Final emission: `isFinal: true` once all in-flight hosts have settled (success / fail / timeout). The
   *    caller can `break` early; outstanding work is bounded by the per-host timeout.
   *
   * No host work runs past its per-host `timeout` — there is no leak risk on early break.
   */
  async *query$(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): AsyncIterable<LookupAnswerProgress> {
    let competentHosts: string[] = []
    if (question.service === 'ls_slap') {
      competentHosts =
        this.networkPreset === 'local' ? ['http://localhost:8080'] : this.slapTrackers
    } else if (this.hostOverrides[question.service] != null) {
      competentHosts = this.hostOverrides[question.service]
    } else if (this.networkPreset === 'local') {
      competentHosts = ['http://localhost:8080']
    } else {
      competentHosts = await this.getCompetentHostsCached(question.service)
    }
    if (this.additionalHosts[question.service]?.length > 0) {
      const extra = this.additionalHosts[question.service]
      const seen = new Set(competentHosts)
      for (const h of extra) if (!seen.has(h)) competentHosts.push(h)
    }
    if (competentHosts.length < 1) {
      throw new Error(
        `No competent ${this.networkPreset} hosts found by the SLAP trackers for lookup service: ${question.service}`
      )
    }

    // Self-healing: if every cached host has slid into backoff (warm cache went
    // stale-by-failure rather than by age), evict the cache and re-discover via
    // SLAP — the network may have rotated healthy hosts in. Only applies to
    // SLAP-eligible services (no overrides, not local, not ls_slap itself).
    let rankedHosts: string[]
    try {
      rankedHosts = this.prepareHostsForQuery(competentHosts, `lookup service ${question.service}`)
    } catch (err) {
      const isSlapEligible =
        question.service !== 'ls_slap' &&
        this.hostOverrides[question.service] == null &&
        this.networkPreset !== 'local'
      if (!isSlapEligible) throw err
      this.hostsCache.delete(question.service)
      // Recovery discovery differs from the normal first-nonempty path: keep
      // listening until a tracker advertises at least one host that is not in
      // backoff, or every tracker settles.
      const fresh = await this.refreshHosts(question.service, true)
      if (this.additionalHosts[question.service]?.length > 0) {
        const extra = this.additionalHosts[question.service]
        const seen = new Set(fresh)
        for (const h of extra) if (!seen.has(h)) fresh.push(h)
      }
      if (fresh.length < 1) {
        throw new Error(
          `No competent ${this.networkPreset} hosts found by the SLAP trackers for lookup service: ${question.service}`
        )
      }
      // Re-rank — if SLAP returned the same hosts and they're all still in
      // backoff, propagate the original error.
      rankedHosts = this.prepareHostsForQuery(fresh, `lookup service ${question.service}`)
    }
    if (rankedHosts.length < 1) {
      throw new Error(
        `All competent hosts for ${question.service} are temporarily unavailable due to backoff.`
      )
    }

    const graceMs = options?.graceMs ?? 80
    const softTimeoutMs = options?.softTimeoutMs
    const onUnreachableHost = options?.onUnreachableHost
    const requestedNotificationCooldownMs = options?.unreachableHostNotificationCooldownMs
    const notificationCooldownMs =
      typeof requestedNotificationCooldownMs === 'number' &&
      Number.isFinite(requestedNotificationCooldownMs) &&
      requestedNotificationCooldownMs >= 0
        ? requestedNotificationCooldownMs
        : DEFAULT_UNREACHABLE_NOTIFICATION_COOLDOWN_MS
    const waitForAllHosts = options?.waitForAllHosts ?? options?.holdForUnknownHosts ?? false

    const hostCount = rankedHosts.length
    const correlationId =
      options?.correlationId ??
      (this.telemetry.enabled ? this.telemetry.createCorrelationId() : undefined)
    const lookupStartedAt = Date.now()
    const outputsMap = new Map<
      string,
      { beef: number[]; context?: number[]; outputIndex: number }
    >()
    const txIds: string[] = []
    let completedHosts = 0
    let successfulHosts = 0
    let emptyHosts = 0
    let failedHosts = 0
    let rejectedHosts = 0
    let freeformHosts = 0
    let firstResponseAt: number | null = null
    let emittedFinal = false

    this.telemetry.capture({
      name: 'sdk.overlay.lookup.started',
      component: 'sdk.lookup-resolver',
      severity: 'debug',
      correlationId,
      attributes: {
        service: question.service,
        network: this.networkPreset,
        hostCount
      }
    })

    type Event =
      | { kind: 'answer'; answer: LookupAnswer }
      | { kind: 'done' }
      | { kind: 'grace' }
      | { kind: 'soft' }
    const queue: Event[] = []
    let waiter: (() => void) | null = null
    const push = (e: Event): void => {
      queue.push(e)
      if (waiter !== null) {
        const w = waiter
        waiter = null
        w()
      }
    }

    for (const host of rankedHosts) {
      const hostStartedAt = Date.now()
      void this.lookupHostWithTracking(host, question, timeout)
        .then(answer => {
          if (isOutputListAnswer(answer)) {
            successfulHosts++
            if (answer.outputs.length === 0) emptyHosts++
            else push({ kind: 'answer', answer })
            this.captureHostTelemetry(
              question.service,
              host,
              answer.outputs.length === 0 ? 'empty' : 'success',
              Date.now() - hostStartedAt,
              correlationId
            )
          } else {
            freeformHosts++
            this.captureHostTelemetry(
              question.service,
              host,
              'freeform',
              Date.now() - hostStartedAt,
              correlationId
            )
          }
        })
        .catch(err => {
          const semanticRejection = isSemanticLookupRejection(err)
          if (semanticRejection) rejectedHosts++
          else failedHosts++
          this.captureHostTelemetry(
            question.service,
            host,
            semanticRejection ? 'rejected' : 'failed',
            Date.now() - hostStartedAt,
            correlationId,
            err
          )
          if (!isSemanticLookupRejection(err) && typeof onUnreachableHost === 'function') {
            const notificationKey = `${question.service}\u0000${host}`
            const now = Date.now()
            const lastNotificationAt =
              this.lastUnreachableNotificationAt.get(notificationKey) ?? Number.NEGATIVE_INFINITY
            if (now - lastNotificationAt < notificationCooldownMs) return
            if (this.lastUnreachableNotificationAt.size >= MAX_NOTIFICATION_DEDUP_ENTRIES) {
              this.evictOldest(this.lastUnreachableNotificationAt)
            }
            this.lastUnreachableNotificationAt.set(notificationKey, now)
            try {
              const callbackResult = onUnreachableHost({
                host,
                service: question.service,
                error: err instanceof Error ? err.message : String(err),
                advertisedBy: this.advertisedBy.get(host)
              })
              void Promise.resolve(callbackResult).catch(() => {
                /* consumer callback is isolated */
              })
            } catch {
              /* never let a consumer callback break the query */
            }
          }
        })
        .finally(() => {
          completedHosts++
          push({ kind: 'done' })
        })
    }

    let softTimer: ReturnType<typeof setTimeout> | null = null
    if (typeof softTimeoutMs === 'number' && softTimeoutMs >= 0) {
      softTimer = setTimeout(() => push({ kind: 'soft' }), softTimeoutMs)
    }

    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let graceFired = false
    let emittedOnce = false

    const mergeAnswer = (answer: LookupAnswer): boolean => {
      let added = false
      const now = Date.now()
      for (const output of answer.outputs) {
        const txId = this.resolveTxIdForOutput(output, now)
        if (txId === null) continue
        const uniqKey = `${txId}.${output.outputIndex}`
        if (!outputsMap.has(uniqKey)) {
          outputsMap.set(uniqKey, output)
          txIds.push(txId)
          added = true
        }
      }
      return added
    }

    const snapshot = (isFinal: boolean): LookupAnswerProgress => ({
      type: 'output-list',
      outputs: Array.from(outputsMap.values()),
      txIds: txIds.slice(),
      isFinal,
      hostCount,
      completedHosts,
      successfulHosts,
      emptyHosts,
      failedHosts,
      rejectedHosts,
      freeformHosts,
      ...(correlationId !== undefined ? { correlationId } : {})
    })

    try {
      while (true) {
        if (completedHosts >= hostCount) break
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            waiter = resolve
          })
        }
        const e = queue.shift() as Event
        if (e.kind === 'answer') {
          const added = mergeAnswer(e.answer)
          if (firstResponseAt === null) {
            firstResponseAt = Date.now()
            if (!graceFired && graceMs > 0) {
              graceTimer = setTimeout(() => {
                graceFired = true
                push({ kind: 'grace' })
              }, graceMs)
            } else {
              graceFired = true
            }
          }
          if (graceFired && added) {
            if (emittedOnce || !waitForAllHosts) {
              emittedOnce = true
              yield snapshot(false)
            }
          }
        } else if (e.kind === 'grace') {
          if (!emittedOnce) {
            if (!waitForAllHosts) {
              emittedOnce = true
              yield snapshot(false)
            }
          }
        } else if (e.kind === 'soft') {
          // Soft timeout is an explicit "bail out early" request from the
          // caller — it overrides a completeness hold.
          if (!emittedOnce) {
            graceFired = true
            emittedOnce = true
            yield snapshot(false)
          }
          if (typeof softTimeoutMs === 'number' && firstResponseAt !== null) {
            // Soft timeout: caller asked to bail out once any answer is in. Yield final.
            break
          }
        } else if (e.kind === 'done') {
          // Continue until every bounded settlement completes. The final
          // snapshot below is the first emission when waitForAllHosts is set.
        }
      }
      const finalSnapshot = snapshot(true)
      emittedFinal = true
      this.captureLookupCompletedTelemetry(
        question.service,
        finalSnapshot,
        Date.now() - lookupStartedAt
      )
      yield finalSnapshot
    } finally {
      if (graceTimer !== null) clearTimeout(graceTimer)
      if (softTimer !== null) clearTimeout(softTimer)
      if (!emittedFinal) {
        this.telemetry.capture({
          name: 'sdk.overlay.lookup.cancelled',
          component: 'sdk.lookup-resolver',
          severity: 'debug',
          correlationId,
          attributes: {
            service: question.service,
            hostCount,
            completedHosts,
            durationMs: Date.now() - lookupStartedAt
          }
        })
      }
    }
  }

  /**
   * Cached wrapper for competent host discovery with stale-while-revalidate.
   */
  private async getCompetentHostsCached(service: string): Promise<string[]> {
    const now = Date.now()
    const cached = this.hostsCache.get(service)

    // if fresh, return immediately
    if (typeof cached === 'object' && cached.expiresAt > now) {
      return cached.hosts.slice()
    }

    // if stale but present, kick off a refresh if not already in-flight and return stale
    if (typeof cached === 'object' && cached.expiresAt <= now) {
      if (!this.hostsInFlight.has(service)) {
        this.hostsInFlight.set(
          service,
          this.refreshHosts(service).finally(() => {
            this.hostsInFlight.delete(service)
          })
        )
      }
      return cached.hosts.slice()
    }

    // no cache: coalesce concurrent requests
    if (this.hostsInFlight.has(service)) {
      try {
        const hosts = await this.hostsInFlight.get(service)
        if (typeof hosts !== 'object') {
          throw new TypeError('Hosts is not defined.')
        }
        return hosts.slice()
      } catch {
        // fall through to a fresh attempt below
      }
    }

    const promise = this.refreshHosts(service).finally(() => {
      this.hostsInFlight.delete(service)
    })
    this.hostsInFlight.set(service, promise)
    const hosts = await promise
    return hosts.slice()
  }

  /**
   * Actually resolves competent hosts from SLAP trackers and updates cache.
   */
  private async refreshHosts(
    service: string,
    requireAvailable: boolean = false
  ): Promise<string[]> {
    const hosts = await this.findCompetentHosts(service, requireAvailable)
    const expiresAt = Date.now() + this.hostsTtlMs

    // bounded cache with simple FIFO eviction
    if (!this.hostsCache.has(service) && this.hostsCache.size >= this.hostsMaxEntries) {
      const oldestKey = this.hostsCache.keys().next().value
      if (oldestKey !== undefined) this.hostsCache.delete(oldestKey)
    }
    this.hostsCache.set(service, { hosts, expiresAt })
    return hosts
  }

  /**
   * Extracts competent host domains from a SLAP tracker response.
   */
  private extractHostsFromAnswer(answer: LookupAnswer, service: string): string[] {
    const hosts: string[] = []
    if (answer.type !== 'output-list') return hosts
    for (const output of answer.outputs) {
      try {
        const tx = Transaction.fromBEEF(output.beef)
        const script = tx.outputs[output.outputIndex]?.lockingScript
        if (typeof script !== 'object' || script === null) continue
        const parsed = OverlayAdminTokenTemplate.decode(script)
        if (parsed.topicOrService !== service || parsed.protocol !== 'SLAP') continue
        if (typeof parsed.domain === 'string' && parsed.domain.length > 0) {
          hosts.push(parsed.domain)
        }
      } catch {
        continue
      }
    }
    return hosts
  }

  /**
   * Returns a list of competent hosts for a given lookup service.
   * Resolves as soon as the first SLAP tracker responds with valid hosts.
   * Remaining trackers continue in the background for reputation tracking.
   * @param service Service for which competent hosts are to be returned
   * @returns Array of hosts competent for resolving queries
   */
  private async findCompetentHosts(
    service: string,
    requireAvailable: boolean = false
  ): Promise<string[]> {
    const query: LookupQuestion = {
      service: 'ls_slap',
      query: { service }
    }

    const trackerHosts = this.prepareHostsForQuery(this.slapTrackers, 'SLAP trackers')
    if (trackerHosts.length === 0) return []

    // Fire all trackers, resolve as soon as any returns valid hosts.
    // Remaining trackers continue in the background for reputation tracking.
    return await new Promise<string[]>(resolve => {
      const allHosts = new Set<string>()
      let resolved = false
      let pending = trackerHosts.length

      for (const tracker of trackerHosts) {
        this.lookupHostWithTracking(tracker, query, MAX_TRACKER_WAIT_TIME)
          .then(answer => {
            const hosts = isOutputListAnswer(answer)
              ? this.extractHostsFromAnswer(answer, service)
              : []
            for (const h of hosts) {
              if (!allHosts.has(h)) {
                allHosts.add(h)
                // First-seen attribution: the tracker that surfaced this host
                // gets credit, used by onUnreachableHost callbacks.
                this.advertisedBy.set(h, tracker)
              }
            }
            const now = Date.now()
            const foundAvailable = [...allHosts].some(host => {
              const backoffUntil = this.hostReputation.snapshot(host)?.backoffUntil ?? 0
              return backoffUntil <= now
            })
            if (!resolved && allHosts.size > 0 && (!requireAvailable || foundAvailable)) {
              resolved = true
              resolve([...allHosts])
            }
          })
          .catch(() => {
            /* tracker failure tracked in reputation */
          })
          .finally(() => {
            pending--
            if (pending === 0 && !resolved) {
              resolved = true
              resolve([...allHosts])
            }
          })
      }
    })
  }

  /**
   * Resolve a txid for an aggregated lookup output. Uses the threaded-through `output.txid`
   * fast path when present; otherwise memoizes Transaction.fromBEEF(beef).id('hex') keyed by
   * the BEEF byte sequence. Returns null when the BEEF is unparseable.
   */
  private resolveTxIdForOutput(
    output: { txid?: string; beef: number[]; outputIndex: number; context?: number[] },
    now: number
  ): string | null {
    if (typeof output.txid === 'string' && output.txid.length > 0) {
      return output.txid
    }
    const keyForBeef = Array.isArray(output.beef) ? output.beef.join(',') : ''
    const memo = this.txMemo.get(keyForBeef)
    if (typeof memo === 'object' && memo !== null && memo.expiresAt > now) {
      return memo.txId
    }
    try {
      const txId = Transaction.fromBEEF(output.beef).id('hex')
      if (this.txMemo.size > 4096) this.evictOldest(this.txMemo)
      this.txMemo.set(keyForBeef, { txId, expiresAt: now + this.txMemoTtlMs })
      return txId
    } catch {
      return null
    }
  }

  /** Evict an arbitrary "oldest" entry from a Map (iteration order). */
  private evictOldest<T>(m: Map<string, T>): void {
    const firstKey = m.keys().next().value
    if (firstKey !== undefined) m.delete(firstKey)
  }

  private assertValidOverrideServices(overrides: Record<string, string[]>): void {
    for (const service of Object.keys(overrides)) {
      if (!service.startsWith('ls_')) {
        throw new Error(`Host override service names must start with "ls_": ${service}`)
      }
    }
  }

  private prepareHostsForQuery(hosts: string[], context: string): string[] {
    if (hosts.length === 0) return []
    const now = Date.now()
    const ranked = this.hostReputation.rankHosts(hosts, now)
    const available = ranked.filter(h => h.backoffUntil <= now).map(h => h.host)
    if (available.length > 0) return available

    const soonest = Math.min(...ranked.map(h => h.backoffUntil))
    const waitMs = Math.max(soonest - now, 0)
    throw new Error(
      `All ${context} hosts are backing off for approximately ${waitMs}ms due to repeated failures.`
    )
  }

  private async lookupHostWithTracking(
    host: string,
    question: LookupQuestion,
    timeout?: number
  ): Promise<LookupFacilitatorAnswer> {
    const startedAt = Date.now()
    const effectiveTimeout =
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
        ? timeout
        : DEFAULT_LOOKUP_TIMEOUT
    const deadline = createDeadline(effectiveTimeout)
    // Start the custom facilitator in a promise chain so synchronous throws
    // become rejections governed by the same wall-clock deadline.
    const lookupPromise = Promise.resolve().then(() =>
      this.facilitator.lookup(host, question, timeout)
    )
    lookupPromise.catch(() => {
      /* deadline may win while custom facilitator settles later */
    })

    let answer: LookupFacilitatorAnswer
    try {
      answer = await Promise.race([lookupPromise, deadline.promise])
    } catch (err) {
      const normalized = normalizeLookupError(err, deadline.didTimeOut())
      if (!isSemanticLookupRejection(err)) this.hostReputation.recordFailure(host, normalized)
      throw isSemanticLookupRejection(err) ? err : normalized
    } finally {
      deadline.cancel()
    }

    if (isOutputListAnswer(answer)) {
      this.hostReputation.recordSuccess(host, Date.now() - startedAt)
      return answer
    }

    // A valid freeform response is neutral: it proves this request reached the
    // service, but it must not erase an availability backoff established by a
    // concurrent failing request and cannot contribute to output aggregation.
    if (isFreeformAnswer(answer)) return answer

    const malformed = new Error('Malformed lookup response')
    this.hostReputation.recordFailure(host, malformed)
    throw malformed
  }

  private captureHostTelemetry(
    service: string,
    host: string,
    outcome: 'success' | 'empty' | 'failed' | 'rejected' | 'freeform',
    durationMs: number,
    correlationId?: string,
    error?: unknown
  ): void {
    let hostOrigin = 'invalid-host'
    try {
      hostOrigin = new URL(host).origin
    } catch {
      // Host input is consumer configuration; never forward paths or query data.
    }
    this.telemetry.capture({
      name: 'sdk.overlay.lookup.host-settled',
      component: 'sdk.lookup-resolver',
      severity: outcome === 'failed' ? 'warn' : 'debug',
      correlationId,
      attributes: {
        service,
        hostOrigin,
        outcome,
        durationMs
      },
      error
    })
  }

  private captureLookupCompletedTelemetry(
    service: string,
    progress: LookupAnswerProgress,
    durationMs: number
  ): void {
    const degraded =
      progress.failedHosts > 0 || progress.rejectedHosts > 0 || progress.freeformHosts > 0
    this.telemetry.capture({
      name: 'sdk.overlay.lookup.completed',
      component: 'sdk.lookup-resolver',
      severity: degraded ? 'warn' : 'info',
      correlationId: progress.correlationId,
      attributes: {
        service,
        durationMs,
        hostCount: progress.hostCount,
        completedHosts: progress.completedHosts,
        successfulHosts: progress.successfulHosts,
        emptyHosts: progress.emptyHosts,
        failedHosts: progress.failedHosts,
        rejectedHosts: progress.rejectedHosts,
        freeformHosts: progress.freeformHosts,
        outputCount: progress.outputs.length,
        isFinal: progress.isFinal
      }
    })
  }
}
