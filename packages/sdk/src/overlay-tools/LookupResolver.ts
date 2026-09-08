import { LookupDiscovery, LookupDiscoveryUpdate } from './LookupDiscovery.js'
import { LookupHostQueue } from './LookupHostQueue.js'
import { readLookupResponseBytes } from './LookupResponseReader.js'
import { DEFAULT_LOOKUP_LIMITS, LookupLimits, LookupResourceLimitError, lookupLimits, normalizeLookupHost, lookupAbortError, withLookupAbort } from './LookupResources.js'
export type { LookupLimits } from './LookupResources.js'
export { DEFAULT_LOOKUP_LIMITS, LookupResourceLimitError } from './LookupResources.js'
import { Transaction } from '../transaction/index.js'
import { Beef } from '../transaction/Beef.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import * as Utils from '../primitives/utils.js'
import { sha256 } from '../primitives/Hash.js'
import { getOverlayHostReputationTracker, HostReputationTracker } from './HostReputationTracker.js'
import { Telemetry, TelemetryConfig } from '../telemetry/Telemetry.js'
import { normalizeBRC100ByteFields, stringifyBRC100 } from '../wallet/BRC100ByteEncoding.js'

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
  /** Abort this query without cancelling discovery still owned by another query. */
  signal?: AbortSignal
  /**
   * Callback intake budget, independent of legacy aggregation. Defaults to 512
   * outputs / 16 MiB of BEEF and context bytes. Values must be positive safe
   * integers. Coordinate these with a downstream verifier's admission limits.
   */
  evidenceLimits?: { maxOutputs?: number; maxBytes?: number }
  /** Whole attempt budget including discovery and queued hosts. Default 10000 ms. */
  deadlineMs?: number
  /** Per-query operational resource limits. These do not define evidence validity. */
  limits?: Partial<LookupLimits>
  /**
   * Owned, UNTRUSTED receipts before legacy txid/outpoint deduplication. Enqueue
   * promptly; callback completion is not awaited and failures are isolated.
   * Intake stops at the configured evidenceLimits, reporting one limit event.
   * No callbacks occur after the query iterator closes. Raw `query$` snapshots
   * remain unverified transport aggregates, not cryptographic proof.
   */
  onEvidence?: (event: LookupEvidenceEvent) => void | Promise<void>
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

/** Additive evidence intake, independent of the legacy aggregated answer. */
export type LookupEvidenceEvent =
  | { type: 'output'; host: string; output: LookupAnswer['outputs'][number] }
  | { type: 'limit' }

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
  /** Transport coverage only, never cryptographic validity or global absence. */
  discoveryComplete?: boolean
  terminalReason?: 'settled' | 'deadline' | 'cancelled' | 'resource-limit'
  discoveredHosts?: number
  skippedHosts?: number
  receivedBytes?: number
  /** Retained decoded BEEF/context octets; JavaScript arrays have additional heap overhead. */
  retainedBytes?: number
  /** Receipt-copy octets handed to onEvidence, independently bounded. */
  evidenceBytes?: number
  trackersTotal?: number
  trackersCompleted?: number
  trackersFailed?: number
  limitsHit?: string[]
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

/** Default TerraTestNet SLAP trackers. */
export const DEFAULT_TTN_SLAP_TRACKERS: string[] = [
  // Canonical staging root; kept separate from testnet to prevent cross-chain discovery.
  'https://staging-overlay.babbage.systems'
]

/** Public overlay network presets understood by lookup and SHIP routing. */
export type LookupNetworkPreset = 'mainnet' | 'testnet' | 'teratestnet' | 'local'

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

function lookupErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return Reflect.apply(String, undefined, [error])
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
  return answer.type === 'freeform' && Object.hasOwn(answer, 'result')
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
  /** Defaults for the bounded discovery, scheduler and receipt intake. */
  limits?: Partial<LookupLimits>
  /**
   * The network preset to use, unless other options override it.
   * - mainnet: use mainnet SLAP trackers and HTTPS facilitator
   * - testnet: use testnet SLAP trackers and HTTPS facilitator
   * - teratestnet: use TerraTestNet SLAP trackers and HTTPS facilitator
   * - local: directly query from localhost:8080 and a facilitator that permits plain HTTP
   */
  networkPreset?: LookupNetworkPreset
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
    timeout?: number,
    signal?: AbortSignal,
    options?: LookupRequestOptions
  ) => Promise<LookupFacilitatorAnswer>
}

/** Optional bounded transport settings; older custom facilitators may ignore these. */
export interface LookupRequestOptions {
  maxResponseBytes?: number
  maxOutputs?: number
  consumeBytes?: (bytes: number) => void
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
    timeout: number = 2000,
    signal?: AbortSignal,
    options?: LookupRequestOptions
  ): Promise<LookupFacilitatorAnswer> {
    if (!url.startsWith('https:') && !this.allowHTTP) {
      throw new Error('HTTPS facilitator can only use URLs that start with "https:"')
    }

    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
    if (signal?.aborted === true) throw lookupAbortError()
    const abort = (): void => controller?.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const deadline = createDeadline(timeout, controller)

    // Hard wall-clock deadline: in some environments (e.g. browser/Electron CORS
    // failures) the underlying fetch can stall without ever settling, and the
    // AbortController signal alone is insufficient to make the returned promise
    // resolve or reject. Race the fetch against a setTimeout-backed reject so
    // the consumer-facing promise always settles within `timeout` ms.
    const fetchPromise = this.performLookupRequest(url, question, controller?.signal, options)
    // Swallow background rejection if the deadline wins first.
    fetchPromise.catch(() => {
      /* noop */
    })

    try {
      return await withLookupAbort(Promise.race([fetchPromise, deadline.promise]), signal)
    } catch (e) {
      if (signal?.aborted) throw lookupAbortError()
      throw normalizeLookupError(e, deadline.didTimeOut())
    } finally {
      deadline.cancel()
      signal?.removeEventListener('abort', abort)
      controller?.abort()
    }
  }

  private async performLookupRequest(
    url: string,
    question: LookupQuestion,
    signal: AbortSignal | undefined,
    options?: LookupRequestOptions
  ): Promise<LookupFacilitatorAnswer> {
    const fco: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aggregation': 'yes'
      },
      body: stringifyBRC100({ service: question.service, query: question.query }),
      signal
    }
    const response: Response = await this.fetchClient(`${url}/lookup`, fco)
    if (signal?.aborted === true || !response.ok) {
      try { void response.body?.cancel().catch(() => {}) } catch { /* best-effort body cleanup */ }
      if (signal?.aborted === true) throw lookupAbortError()
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
    const payload = await readLookupResponseBytes(response, {
      signal,
      maxResponseBytes: options?.maxResponseBytes ?? DEFAULT_LOOKUP_LIMITS.maxResponseBytes,
      consumeBytes: options?.consumeBytes
    })
    if (isOctetStream(response.headers.get('content-type'))) {
      return await this.parseOctetStreamLookup(payload, signal, options)
    }
    const answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    if (
      answer != null &&
      typeof answer === 'object' &&
      !Array.isArray(answer) &&
      answer.type === 'output-list' &&
      Array.isArray(answer.outputs)
    ) {
      if (answer.outputs.length > (options?.maxOutputs ?? DEFAULT_LOOKUP_LIMITS.maxOutputs)) throw new LookupResourceLimitError('maxOutputs')
      for (const output of answer.outputs) {
        normalizeBRC100ByteFields(output, ['beef', 'context'])
      }
    }
    return answer
  }

  /** Parse the aggregated octet-stream lookup response into an output-list LookupAnswer. */
  private async parseOctetStreamLookup(payload: Uint8Array, signal?: AbortSignal, options?: LookupRequestOptions): Promise<LookupAnswer> {
    const r = new Utils.Reader(Array.from(payload))
    const nOutpoints = r.readVarIntNum()
    if (!Number.isSafeInteger(nOutpoints) || nOutpoints < 0 || nOutpoints > (options?.maxOutputs ?? DEFAULT_LOOKUP_LIMITS.maxOutputs)) throw new LookupResourceLimitError('maxOutputs')
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
    const outputs = await this.extractAtomicOutputs(outpoints, beefObj, signal, options)
    return { type: 'output-list', outputs }
  }

  /** Memoize per-txid atomic BEEF extraction, yielding to the event loop between outputs. */
  private async extractAtomicOutputs(
    outpoints: Array<{ txid: string; outputIndex: number; context?: number[] }>,
    beefObj: Beef,
    signal?: AbortSignal,
    options?: LookupRequestOptions
  ): Promise<Array<{ outputIndex: number; context?: number[]; beef: number[]; txid: string }>> {
    const beefByTxid = new Map<string, number[]>()
    const outputs: Array<{
      outputIndex: number
      context?: number[]
      beef: number[]
      txid: string
    }> = Array.from({ length: outpoints.length })
    let extractedBytes = 0
    for (let idx = 0; idx < outpoints.length; idx++) {
      if (signal?.aborted === true) throw lookupAbortError()
      const x = outpoints[idx]
      let beefBytes = beefByTxid.get(x.txid)
      if (beefBytes === undefined) {
        beefBytes = beefObj.toBinaryAtomic(x.txid)
        beefByTxid.set(x.txid, beefBytes)
      }
      extractedBytes += beefBytes.length + (x.context?.length ?? 0)
      if (extractedBytes > (options?.maxResponseBytes ?? DEFAULT_LOOKUP_LIMITS.maxResponseBytes)) throw new LookupResourceLimitError('maxResponseBytes')
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

interface LookupQuerySessionOptions {
  graceMs: number
  softTimeoutMs?: number
  waitForAllHosts: boolean
  correlationId?: string
  limits: LookupLimits
  onEvidence?: LookupQueryOptions['onEvidence']
  resolveTxId: (output: LookupAnswer['outputs'][number], now: number) => string | null
}

/** A single cumulative snapshot plus a wake flag, regardless of listener speed. */
class LookupQuerySession {
  readonly startedAt = Date.now()
  readonly correlationId?: string
  hostCount = 0
  completedHosts = 0
  successfulHosts = 0
  emptyHosts = 0
  failedHosts = 0
  rejectedHosts = 0
  freeformHosts = 0
  emittedFinal = false
  closed = false
  accepting = true
  discoveryComplete = false
  discoveredHosts = 0
  skippedHosts = 0
  receivedBytes = 0
  retainedBytes = 0
  trackersTotal = 0
  trackersCompleted = 0
  trackersFailed = 0
  readonly limitsHit = new Set<string>()
  terminalReason: NonNullable<LookupAnswerProgress['terminalReason']> = 'settled'
  private evidenceOutputs = 0
  private evidenceBytes = 0
  private evidenceLimited = false
  private limitNotificationSent = false
  private readonly outputsMap = new Map<string, LookupAnswer['outputs'][number]>()
  private readonly txIds: string[] = []
  private waiter: (() => void) | null = null
  private dirty = false
  private finished = false
  private failure: unknown
  private firstResponseAt: number | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private softTimer: ReturnType<typeof setTimeout> | null = null
  private graceFired = false
  private softFired = false

  constructor(private readonly options: LookupQuerySessionOptions) {
    this.correlationId = options.correlationId
  }

  wake(): void {
    this.dirty = true
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  limit(name: string): void {
    this.limitsHit.add(name)
    if (!this.limitNotificationSent && this.accepting) {
      this.limitNotificationSent = true
      try { void Promise.resolve(this.options.onEvidence?.({ type: 'limit' })).catch(() => {}) } catch { /* consumer isolation */ }
    }
    if (this.terminalReason === 'settled') this.terminalReason = 'resource-limit'
    this.wake()
  }

  receiveEvidence(host: string, answer: LookupAnswer, callback: LookupQueryOptions['onEvidence']): void {
    if (callback === undefined || this.closed || !this.accepting || this.evidenceLimited) return
    const deliver = (event: LookupEvidenceEvent): void => {
      try { void Promise.resolve(callback(event)).catch(() => {}) } catch { /* consumer isolation */ }
    }
    for (const output of answer.outputs) {
      if (!this.accepting || this.closed) break
      const bytes = output.beef.length + (output.context?.length ?? 0)
      if (this.evidenceOutputs >= this.options.limits.maxEvidenceOutputs ||
          bytes > this.options.limits.maxEvidenceBytes - this.evidenceBytes) {
        this.evidenceLimited = true
        this.limit(this.evidenceOutputs >= this.options.limits.maxEvidenceOutputs ? 'maxEvidenceOutputs' : 'maxEvidenceBytes')
        break
      }
      this.evidenceOutputs++
      this.evidenceBytes += bytes
      deliver({ type: 'output', host, output: {
        ...output, beef: output.beef.slice(),
        ...(output.context === undefined ? {} : { context: output.context.slice() })
      } })
    }
  }

  recordOutputAnswer(answer: LookupAnswer): void {
    if (this.closed || !this.accepting) return
    this.successfulHosts++
    if (answer.outputs.length === 0) { this.emptyHosts++; return }
    this.mergeAnswer(answer)
    if (this.firstResponseAt === null) {
      this.firstResponseAt = Date.now()
      if (this.options.graceMs > 0) this.graceTimer = setTimeout(() => {
        this.graceFired = true; this.wake()
      }, this.options.graceMs)
      else this.graceFired = true
    }
    this.wake()
  }

  recordFreeformAnswer(): void { if (!this.closed) this.freeformHosts++ }
  recordRejection(): void { if (!this.closed) this.rejectedHosts++ }
  recordAvailabilityFailure(): void { if (!this.closed) this.failedHosts++ }
  recordDone(): void { if (!this.closed) { this.completedHosts++; this.wake() } }

  private mergeAnswer(answer: LookupAnswer): void {
    const now = Date.now()
    for (const output of answer.outputs) {
      const txId = this.options.resolveTxId(output, now)
      if (txId === null) continue
      const key = `${txId}.${output.outputIndex}`
      if (this.outputsMap.has(key)) continue
      if (this.outputsMap.size >= this.options.limits.maxOutputs) { this.limit('maxOutputs'); break }
      this.outputsMap.set(key, output)
      this.txIds.push(txId)
    }
  }

  finish(error?: unknown): void { this.failure = error; this.finished = true; this.wake() }

  snapshot(isFinal: boolean): LookupAnswerProgress {
    return {
      type: 'output-list', outputs: Array.from(this.outputsMap.values()), txIds: this.txIds.slice(),
      isFinal, hostCount: this.hostCount, completedHosts: this.completedHosts,
      successfulHosts: this.successfulHosts, emptyHosts: this.emptyHosts, failedHosts: this.failedHosts,
      rejectedHosts: this.rejectedHosts, freeformHosts: this.freeformHosts,
      discoveryComplete: this.discoveryComplete,
      ...(isFinal ? { terminalReason: this.terminalReason } : {}),
      discoveredHosts: this.discoveredHosts, skippedHosts: this.skippedHosts,
      receivedBytes: this.receivedBytes, retainedBytes: this.retainedBytes, evidenceBytes: this.evidenceBytes, trackersTotal: this.trackersTotal,
      trackersCompleted: this.trackersCompleted, trackersFailed: this.trackersFailed,
      limitsHit: Array.from(this.limitsHit),
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {})
    }
  }

  close(): void {
    this.closed = true
    this.accepting = false
    if (this.graceTimer !== null) clearTimeout(this.graceTimer)
    if (this.softTimer !== null) clearTimeout(this.softTimer)
    this.wake()
  }

  async *progress(): AsyncIterable<LookupAnswerProgress> {
    if (typeof this.options.softTimeoutMs === 'number' && this.options.softTimeoutMs >= 0) {
      this.softTimer = setTimeout(() => { this.softFired = true; this.wake() }, this.options.softTimeoutMs)
    }
    try {
      while (!this.closed) {
        if (this.finished) {
          if (this.failure !== undefined) throw this.failure
          this.emittedFinal = true
          yield this.snapshot(true)
          return
        }
        if (this.dirty && (this.softFired || (this.graceFired && !this.options.waitForAllHosts))) {
          this.dirty = false
          yield this.snapshot(false)
        } else {
          this.dirty = false
          await new Promise<void>(resolve => { this.waiter = resolve })
        }
      }
    } finally { this.close() }
  }
}

interface LookupHostFailureContext {
  session: LookupQuerySession
  service: string
  host: string
  hostStartedAt: number
  correlationId: string | undefined
  onUnreachableHost: LookupQueryOptions['onUnreachableHost']
  notificationCooldownMs: number
}

/**
 * Represents a Lookup Resolver.
 */
export default class LookupResolver {
  private readonly facilitator: OverlayLookupFacilitator
  private readonly slapTrackers: string[]
  private readonly hostOverrides: Record<string, string[]>
  private readonly additionalHosts: Record<string, string[]>
  private readonly networkPreset: LookupNetworkPreset
  private readonly hostReputation: HostReputationTracker
  private readonly telemetry: Telemetry

  // ---- Caches / memoization ----
  private readonly hostsCache: Map<string, { hosts: string[]; expiresAt: number; discoveryComplete?: boolean; trackersFailed?: number; limitsHit?: string[] }>
  private readonly hostsInFlight: Map<string, LookupDiscovery>
  private readonly limits: LookupLimits
  private activeQueries = 0
  private trackerCursor = 0
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
    this.limits = lookupLimits(config.limits)
    this.networkPreset = config.networkPreset ?? 'mainnet'
    this.facilitator =
      config.facilitator ??
      new HTTPSOverlayLookupFacilitator(undefined, this.networkPreset === 'local')
    this.slapTrackers = config.slapTrackers ?? this.defaultSlapTrackers()
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

  private defaultSlapTrackers(): string[] {
    switch (this.networkPreset) {
      case 'mainnet':
        return DEFAULT_SLAP_TRACKERS
      case 'testnet':
        return DEFAULT_TESTNET_SLAP_TRACKERS
      case 'teratestnet':
        return DEFAULT_TTN_SLAP_TRACKERS
      case 'local':
        return []
    }
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

  private unreachableNotificationCooldown(
    options: LookupQueryOptions | undefined
  ): number {
    const requested = options?.unreachableHostNotificationCooldownMs
    return typeof requested === 'number' &&
      Number.isFinite(requested) &&
      requested >= 0
      ? requested
      : DEFAULT_UNREACHABLE_NOTIFICATION_COOLDOWN_MS
  }

  private notifyUnreachableHost(
    host: string,
    service: string,
    error: unknown,
    callback: LookupQueryOptions['onUnreachableHost'],
    cooldownMs: number
  ): void {
    if (typeof callback !== 'function') return
    const notificationKey = `${service}\u0000${host}`
    const now = Date.now()
    const lastNotificationAt =
      this.lastUnreachableNotificationAt.get(notificationKey) ??
      Number.NEGATIVE_INFINITY
    if (now - lastNotificationAt < cooldownMs) return
    if (
      this.lastUnreachableNotificationAt.size >=
      MAX_NOTIFICATION_DEDUP_ENTRIES
    ) {
      this.evictOldest(this.lastUnreachableNotificationAt)
    }
    this.lastUnreachableNotificationAt.set(notificationKey, now)
    try {
      const result = callback({
        host,
        service,
        error: lookupErrorMessage(error),
        advertisedBy: this.advertisedBy.get(host)
      })
      void Promise.resolve(result).catch(() => {
        /* consumer callback is isolated */
      })
    } catch {
      /* never let a consumer callback break the query */
    }
  }

  private recordLookupHostAnswer(
    session: LookupQuerySession,
    service: string,
    host: string,
    answer: LookupFacilitatorAnswer,
    hostStartedAt: number,
    correlationId: string | undefined
  ): void {
    if (isOutputListAnswer(answer)) {
      session.recordOutputAnswer(answer)
      this.captureHostTelemetry(
        service,
        host,
        answer.outputs.length === 0 ? 'empty' : 'success',
        Date.now() - hostStartedAt,
        correlationId
      )
      return
    }
    session.recordFreeformAnswer()
    this.captureHostTelemetry(
      service,
      host,
      'freeform',
      Date.now() - hostStartedAt,
      correlationId
    )
  }

  private recordLookupHostFailure(
    context: LookupHostFailureContext,
    error: unknown
  ): void {
    const {
      session,
      service,
      host,
      hostStartedAt,
      correlationId,
      onUnreachableHost,
      notificationCooldownMs
    } = context
    const semanticRejection = isSemanticLookupRejection(error)
    if (semanticRejection) session.recordRejection()
    else session.recordAvailabilityFailure()
    this.captureHostTelemetry(
      service,
      host,
      semanticRejection ? 'rejected' : 'failed',
      Date.now() - hostStartedAt,
      correlationId,
      error
    )
    if (!semanticRejection) {
      this.notifyUnreachableHost(
        host,
        service,
        error,
        onUnreachableHost,
        notificationCooldownMs
      )
    }
  }

  /**
   * Cumulative unverified results. Discovery remains subscribed while trackers
   * settle; each new host enters the bounded queue immediately. Caller abort,
   * deadline and iterator close release this query's ownership.
   */
  query$(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): AsyncIterable<LookupAnswerProgress> {
    const cancellation = new AbortController()
    const iterator = this.queryProgress(question, timeout, options, cancellation.signal)[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => await iterator.next(),
        return: async () => {
          cancellation.abort()
          return await iterator.return?.() ?? { done: true, value: undefined }
        },
        throw: async (error?: unknown) => {
          cancellation.abort()
          if (iterator.throw !== undefined) return await iterator.throw(error)
          throw error
        }
      })
    }
  }

  private async *queryProgress(inputQuestion: LookupQuestion, timeout: number | undefined,
    options: LookupQueryOptions | undefined, iteratorSignal: AbortSignal): AsyncIterable<LookupAnswerProgress> {
    // Capture JSON wire values once, before any discovery or queued host can
    // observe a caller's later mutation. Custom non-JSON questions retain their
    // historical facilitator-defined semantics when they cannot be cloned.
    let question: LookupQuestion
    try { question = structuredClone(inputQuestion) }
    catch {
      if (this.facilitator instanceof HTTPSOverlayLookupFacilitator) question = JSON.parse(stringifyBRC100(inputQuestion)) as LookupQuestion
      else question = { ...inputQuestion }
    }
    const limits = lookupLimits(this.limits, options?.limits, {
      ...(options?.evidenceLimits?.maxOutputs === undefined ? {} : { maxEvidenceOutputs: options.evidenceLimits.maxOutputs }),
      ...(options?.evidenceLimits?.maxBytes === undefined ? {} : { maxEvidenceBytes: options.evidenceLimits.maxBytes })
    })
    const deadlineMs = options?.deadlineMs ?? 10_000
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 2_147_483_647) {
      throw new RangeError('Lookup deadlineMs must be between 0 and 2147483647')
    }
    if (this.activeQueries >= 128) throw new LookupResourceLimitError('activeQueries')
    this.activeQueries++
    const controller = new AbortController()
    const session = new LookupQuerySession({
      graceMs: options?.graceMs ?? 80, softTimeoutMs: options?.softTimeoutMs,
      waitForAllHosts: options?.waitForAllHosts ?? options?.holdForUnknownHosts ?? false,
      correlationId: options?.correlationId ?? (this.telemetry.enabled ? this.telemetry.createCorrelationId() : undefined),
      limits, onEvidence: options?.onEvidence, resolveTxId: (output, now) => this.resolveTxIdForOutput(output, now)
    })
    let releaseDiscovery: (() => void) | undefined
    let discoveryFinished = false
    let noHostsError: Error | undefined
    const seen = new Set<string>()
    let sourceQuota = limits.maxHosts
    let discoveryBytes = 0
    let discoverySkipped = 0
    const processedSources = new Set<string>()
    const consume = (bytes: number): void => {
      if (controller.signal.aborted) throw lookupAbortError()
      if (bytes > limits.maxTotalBytes - session.receivedBytes) {
        session.limit('maxTotalBytes')
        throw new LookupResourceLimitError('maxTotalBytes')
      }
      session.receivedBytes += bytes
    }
    const queue = new LookupHostQueue(limits.maxHosts, limits.hostConcurrency, async host => {
      if (controller.signal.aborted) return
      session.hostCount++
      const startedAt = Date.now()
      try {
        const answer = await this.lookupHostWithTracking(host, question, timeout, controller.signal, {
          maxResponseBytes: limits.maxResponseBytes, maxOutputs: limits.maxOutputs, consumeBytes: consume
        })
        if (controller.signal.aborted || session.closed) return
        let ownedAnswer = answer
        if (isOutputListAnswer(answer)) {
          let retained = 0
          for (const output of answer.outputs) retained += output.beef.length + (output.context?.length ?? 0)
          if (retained > limits.maxTotalBytes - session.retainedBytes) throw new LookupResourceLimitError('maxTotalBytes')
          session.retainedBytes += retained
          ownedAnswer = { type: 'output-list', outputs: answer.outputs.map(output => ({
            ...output, beef: output.beef.slice(), ...(output.context === undefined ? {} : { context: output.context.slice() })
          })) }
          session.receiveEvidence(host, ownedAnswer, options?.onEvidence)
        }
        if (controller.signal.aborted || session.closed) return
        this.recordLookupHostAnswer(session, question.service, host, ownedAnswer, startedAt, session.correlationId)
      } catch (error) {
        if (controller.signal.aborted || session.closed) return
        if (error instanceof LookupResourceLimitError) session.limit(error.limit)
        else this.recordLookupHostFailure({
          session, service: question.service, host, hostStartedAt: startedAt,
          correlationId: session.correlationId, onUnreachableHost: options?.onUnreachableHost,
          notificationCooldownMs: this.unreachableNotificationCooldown(options)
        }, error)
      } finally { session.recordDone() }
    }, (count, limited) => { if (count > 0) { session.skippedHosts += count; if (limited) session.limit('maxHosts') } })

    const stop = (reason: 'deadline' | 'cancelled'): void => {
      if (controller.signal.aborted) return
      session.limit(reason)
      session.terminalReason = reason
      session.accepting = false
      session.discoveryComplete = false
      controller.abort()
      releaseDiscovery?.()
      discoveryFinished = true
      queue.cancel()
    }
    const abort = (): void => stop('cancelled')
    options?.signal?.addEventListener('abort', abort, { once: true })
    iteratorSignal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('deadline'), deadlineMs)

    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      session.close()
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abort)
      iteratorSignal.removeEventListener('abort', abort)
      controller.abort()
      releaseDiscovery?.()
      queue.cancel()
      this.activeQueries--
    }

    const admit = (source: string, candidates: string[]): void => {
      if (controller.signal.aborted) return
      const hosts: string[] = []
      const scanLimit = Math.min(candidates.length, limits.maxHosts * 4)
      if (candidates.length > scanLimit) { session.skippedHosts += candidates.length - scanLimit; session.limit('maxHosts') }
      for (let candidateIndex = 0; candidateIndex < scanLimit; candidateIndex++) {
        const candidate = candidates[candidateIndex]
        const host = normalizeLookupHost(candidate, source === 'configured' || source === 'additional')
        if (host === null) { session.skippedHosts++; continue }
        if (seen.has(host)) continue
        // Keep this dedup set finite, too. Source-level discovery reservations
        // protect later trackers before candidates reach this queue.
        if (seen.size >= limits.maxHosts) { session.skippedHosts++; session.limit('maxHosts'); continue }
        seen.add(host)
        session.discoveredHosts++
        hosts.push(host)
      }
      if (hosts.length === 0) return
      try {
        const available = this.prepareHostsForQuery(hosts, `lookup service ${question.service}`)
        session.skippedHosts += hosts.length - available.length
        queue.add(source, available)
      } catch (error) {
        session.skippedHosts += hosts.length
        noHostsError = error instanceof Error ? error : new Error(lookupErrorMessage(error))
      }
    }
    const sourcesDone = (): void => {
      discoveryFinished = true
      queue.finishSources()
    }
    const acceptDiscovery = (state: LookupDiscoveryUpdate): void => {
      if (controller.signal.aborted) return
      session.trackersTotal = state.trackersTotal
      session.trackersCompleted = state.trackersCompleted
      session.trackersFailed = state.trackersFailed
      session.skippedHosts += state.skippedHosts - discoverySkipped
      discoverySkipped = state.skippedHosts
      for (const name of state.limitsHit) session.limit(name)
      try { consume(state.receivedBytes - discoveryBytes) } catch (error) {
        if (error instanceof LookupResourceLimitError) session.limit(error.limit)
        controller.abort()
        releaseDiscovery?.()
        queue.cancel()
        discoveryFinished = true
        return
      }
      discoveryBytes = state.receivedBytes
      for (const [source, hosts] of state.sources) {
        if (processedSources.has(source)) continue
        processedSources.add(source)
        admit(source, hosts.slice(0, sourceQuota))
        if (hosts.length > sourceQuota) {
          session.skippedHosts += hosts.length - sourceQuota
          session.limit('maxHostsPerTracker')
        }
      }
      session.discoveryComplete = state.done && state.trackersFailed === 0 && state.limitsHit.size === 0 && state.skippedHosts === 0
      session.wake()
      if (state.done) sourcesDone()
    }
    try {
      this.telemetry.capture({ name: 'sdk.overlay.lookup.started', component: 'sdk.lookup-resolver',
        severity: 'debug', correlationId: session.correlationId,
        attributes: { service: question.service, network: this.networkPreset, hostCount: 0 } })
      if (options?.signal?.aborted === true || iteratorSignal.aborted) abort()
      if (!controller.signal.aborted) {
        if (question.service === 'ls_slap' || this.hostOverrides[question.service] != null || this.networkPreset === 'local') {
          const direct = question.service === 'ls_slap'
            ? (this.networkPreset === 'local' ? ['http://localhost:8080'] : this.slapTrackers)
            : this.hostOverrides[question.service] ?? ['http://localhost:8080']
          admit('configured', direct)
          admit('additional', this.additionalHosts[question.service] ?? [])
          session.discoveryComplete = true
          sourcesDone()
        } else {
          const cached = this.hostsCache.get(question.service)
          const configuredAdditional = this.additionalHosts[question.service] ?? []
          const cacheAvailable = cached?.hosts.some(host => (this.hostReputation.snapshot(host)?.backoffUntil ?? 0) <= Date.now()) ?? false
          const key = JSON.stringify([question.service, limits.maxHosts, limits.maxHostsPerTracker,
            limits.maxTrackers, limits.trackerConcurrency, limits.maxResponseBytes, limits.maxTotalBytes, limits.maxOutputs])
          let discovery = this.hostsInFlight.get(key)
          const refresh = discovery !== undefined || cached === undefined || cached.expiresAt <= Date.now() || !cacheAvailable
          const initialSources = Number(cached !== undefined && cacheAvailable) + Number(configuredAdditional.length > 0)
          const initialQuota = refresh ? Math.max(1, Math.floor(limits.maxHosts / (initialSources + Math.max(1, Math.min(this.slapTrackers.length, limits.maxTrackers))))) : limits.maxHosts
          if (cached !== undefined && cacheAvailable) {
            // Reserve a source share for cached membership and each late tracker.
            const cachedLimit = initialQuota
            admit('cache', cached.hosts.slice(0, cachedLimit))
            if (cached.hosts.length > cachedLimit) { session.skippedHosts += cached.hosts.length - cachedLimit; session.limit('maxHosts') }
          }
          if (configuredAdditional.length > 0) {
            admit('additional', configuredAdditional.slice(0, initialQuota))
            if (configuredAdditional.length > initialQuota) { session.skippedHosts += configuredAdditional.length - initialQuota; session.limit('maxHosts') }
          }
          if (refresh) {
            sourceQuota = Math.max(1, Math.floor((limits.maxHosts - seen.size) / Math.max(1, Math.min(this.slapTrackers.length, limits.maxTrackers))))
            if (discovery === undefined) {
              let trackers: string[] = []
              const selected: string[] = []
              const scan = Math.min(this.slapTrackers.length, limits.maxTrackers)
              for (let i = 0; i < scan; i++) selected.push(this.slapTrackers[(this.trackerCursor + i) % this.slapTrackers.length])
              this.trackerCursor = (this.trackerCursor + scan) % Math.max(1, this.slapTrackers.length)
              const normalized = Array.from(new Set(selected.map(host => normalizeLookupHost(host)).filter((host): host is string => host !== null)))
              try { trackers = this.prepareHostsForQuery(normalized.slice(0, limits.maxTrackers), 'SLAP trackers') }
              catch (error) { noHostsError = error instanceof Error ? error : new Error(lookupErrorMessage(error)) }
              discovery = new LookupDiscovery(trackers, limits, async (tracker, signal, charge) => {
                const answer = await this.lookupHostWithTracking(tracker, { service: 'ls_slap', query: { service: question.service } }, MAX_TRACKER_WAIT_TIME, signal,
                  { maxResponseBytes: limits.maxResponseBytes, maxOutputs: limits.maxOutputs, consumeBytes: charge })
                const hosts = isOutputListAnswer(answer) ? this.extractHostsFromAnswer(answer, question.service) : []
                for (const host of hosts) {
                  if (this.advertisedBy.size >= this.hostsMaxEntries * limits.maxHosts) this.evictOldest(this.advertisedBy)
                  this.advertisedBy.set(host, tracker)
                }
                return hosts
              }, (state, abandoned) => {
                if (this.hostsInFlight.get(key) !== discovery) return
                this.hostsInFlight.delete(key)
                if (abandoned) return
                const hosts = Array.from(new Set(Array.from(state.sources.values()).flat())).slice(0, limits.maxHosts)
                if (!this.hostsCache.has(question.service) && this.hostsCache.size >= this.hostsMaxEntries) this.evictOldest(this.hostsCache)
                this.hostsCache.set(question.service, { hosts, expiresAt: Date.now() + this.hostsTtlMs, discoveryComplete: state.trackersFailed === 0 && state.limitsHit.size === 0 && state.skippedHosts === 0, trackersFailed: state.trackersFailed, limitsHit: Array.from(state.limitsHit) })
              })
              if (this.slapTrackers.length > limits.maxTrackers) discovery.state.limitsHit.add('maxTrackers')
              if (normalized.length !== this.slapTrackers.length || trackers.length < Math.min(normalized.length, limits.maxTrackers)) {
                discovery.state.skippedHosts += this.slapTrackers.length - trackers.length
              }
              this.hostsInFlight.set(key, discovery)
            }
            releaseDiscovery = discovery.subscribe(acceptDiscovery)
            if (controller.signal.aborted) releaseDiscovery()
          } else {
            session.discoveryComplete = cached?.discoveryComplete ?? true
            session.trackersFailed = cached?.trackersFailed ?? 0
            for (const name of cached?.limitsHit ?? []) session.limit(name)
            sourcesDone()
          }
        }
      } else queue.cancel()
      void queue.done.then(() => {
        const error = session.hostCount === 0 && session.terminalReason === 'settled'
          ? noHostsError ?? new Error(`No competent ${this.networkPreset} hosts found by the SLAP trackers for lookup service: ${question.service}`)
          : undefined
        if (discoveryFinished) session.finish(error)
      })
      for await (const progress of session.progress()) {
        if (progress.isFinal) {
          this.captureLookupCompletedTelemetry(question.service, progress, Date.now() - session.startedAt)
          cleanup()
        }
        yield progress
      }
    } finally { cleanup() }
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
    const keyForBeef = Utils.toHex(sha256(output.beef))
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
    timeout?: number,
    signal?: AbortSignal,
    options?: LookupRequestOptions
  ): Promise<LookupFacilitatorAnswer> {
    const startedAt = Date.now()
    const effectiveTimeout =
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
        ? timeout
        : DEFAULT_LOOKUP_TIMEOUT
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const deadline = createDeadline(effectiveTimeout, controller)
    let reportedBytes = 0
    const requestOptions = { ...options, consumeBytes: (bytes: number): void => {
      options?.consumeBytes?.(bytes); reportedBytes += bytes
    } }
    // Start the custom facilitator in a promise chain so synchronous throws
    // become rejections governed by the same wall-clock deadline.
    const lookupPromise = Promise.resolve().then(() =>
      signal?.aborted === true ? Promise.reject(lookupAbortError()) : this.facilitator.lookup(host, question, timeout, controller.signal, requestOptions)
    )
    lookupPromise.catch(() => {
      /* deadline may win while custom facilitator settles later */
    })

    let answer: LookupFacilitatorAnswer
    try {
      answer = await withLookupAbort(Promise.race([lookupPromise, deadline.promise]), signal)
    } catch (err) {
      if (signal?.aborted === true) throw lookupAbortError()
      if (err instanceof LookupResourceLimitError) throw err
      const normalized = normalizeLookupError(err, deadline.didTimeOut())
      if (!isSemanticLookupRejection(err)) this.hostReputation.recordFailure(host, normalized)
      throw isSemanticLookupRejection(err) ? err : normalized
    } finally {
      deadline.cancel()
      signal?.removeEventListener('abort', abort)
      controller.abort()
    }

    if (signal?.aborted === true) throw lookupAbortError()
    if (answer != null && answer.type === 'output-list' && Array.isArray(answer.outputs) && answer.outputs.length > (options?.maxOutputs ?? DEFAULT_LOOKUP_LIMITS.maxOutputs)) throw new LookupResourceLimitError('maxOutputs')
    if (isOutputListAnswer(answer)) {
      let bytes = 0
      for (const output of answer.outputs) {
        bytes += output.beef.length + (output.context?.length ?? 0)
        if (bytes > (options?.maxResponseBytes ?? DEFAULT_LOOKUP_LIMITS.maxResponseBytes)) throw new LookupResourceLimitError('maxResponseBytes')
      }
      if (reportedBytes === 0) options?.consumeBytes?.(bytes)
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
