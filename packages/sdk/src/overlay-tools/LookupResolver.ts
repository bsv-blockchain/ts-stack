import { boundLookupResponse } from './boundLookupResponse.js'
import { Transaction } from '../transaction/index.js'
import { Beef } from '../transaction/Beef.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import * as Utils from '../primitives/utils.js'
import { ReliableHostReputation, type ReliableReputationStorage } from './ReliableHostReputation.js'
import {
  withinDeadline,
  monotonicNow,
  boundedMs,
  normalizeHosts,
  requestReliableHost,
  LookupValidationError,
  type ReliableLookupOptions,
  type ReliableLookupResult
} from './ReliableLookup.js'
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
 * All optional; shared deadline and failure semantics apply to every service.
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
  /** Total discovery and lookup budget. Default 5000 ms; maximum 30000 ms. */
  deadlineMs?: number
  /** Cancels discovery and outstanding host requests. */
  signal?: AbortSignal
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
  /** Whether every selected discovery tracker completed without truncation. */
  discoveryComplete?: boolean
  /** Transport completion only; never proof of authoritative absence or freshness. */
  status?: 'complete' | 'incomplete' | 'unavailable'
  /** Correlation id used for privacy-safe distributed diagnostics. */
  correlationId?: string
}

/** A lookup answer together with the host settlement evidence behind it. */
export interface LookupResolution {
  answer: LookupAnswer
  progress: LookupAnswerProgress
}

/** An empty aggregate could not be distinguished from infrastructure failure. */
export class LookupUnavailableError extends Error {
  readonly retryable = true
  constructor(readonly progress: LookupAnswerProgress) {
    super('Overlay lookup temporarily unavailable or incomplete')
    this.name = 'LookupUnavailableError'
  }
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

const MAX_TRACKER_WAIT_TIME = 1500
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
    answer.outputs.length <= 256 &&
    answer.outputs.every(isLookupOutput)
  )
}

function isFreeformAnswer(value: unknown): value is LookupFreeformAnswer {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  return answer.type === 'freeform' && Object.hasOwn(answer, 'result')
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
  /** @deprecated Discovery is refreshed on every lookup; this setting is ignored. */
  hostsTtlMs?: number
  /** @deprecated Discovery is no longer cached; this setting is ignored. */
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
  /** Transaction memo tuning; legacy host-cache options are accepted but ignored. */
  cache?: CacheOptions
  /** Legacy storage option. Use reliableReputationStorage for atomic v4 persistence; get/set-only stores use memory health. */
  reputationStorage?:
    | 'localStorage'
    | { get: (key: string) => string | null | undefined; set: (key: string, value: string) => void }
  /** Atomic v4 reputation storage. Legacy host-only records are ignored automatically. */
  reliableReputationStorage?: ReliableReputationStorage
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
    signal?: AbortSignal
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

  lookup(
    url: string,
    question: LookupQuestion,
    timeout: number = 2000,
    signal?: AbortSignal
  ): Promise<LookupFacilitatorAnswer> {
    if (!url.startsWith('https:') && !this.allowHTTP) {
      return Promise.reject(
        new Error('HTTPS facilitator can only use URLs that start with "https:"')
      )
    }

    return withinDeadline(
      child => this.performLookupRequest(url, question, child),
      timeout,
      signal
    ).catch(error => {
      if ((error as { name?: string })?.name === 'AbortError') throw new Error('Request timed out')
      if (error instanceof Error) throw error
      throw new Error(Utils.toSafeString(error, 'Unknown error'))
    })
  }

  protected async performLookupRequest(
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
      body: stringifyBRC100({ service: question.service, query: question.query }),
      signal
    }
    let response: Response = await this.fetchClient(`${url}/lookup`, fco)
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
    response = await boundLookupResponse(response, signal)
    if (isOctetStream(response.headers.get('content-type'))) {
      return await this.parseOctetStreamLookup(response)
    }
    const answer = await response.json()
    if (
      answer != null &&
      typeof answer === 'object' &&
      !Array.isArray(answer) &&
      answer.type === 'output-list' &&
      Array.isArray(answer.outputs)
    ) {
      for (const output of answer.outputs) {
        normalizeBRC100ByteFields(output, ['beef', 'context'])
      }
    }
    return answer
  }

  /** Parse the aggregated octet-stream lookup response into an output-list LookupAnswer. */
  private parseOctetStreamLookup(response: Response): Promise<LookupAnswer> {
    return response.arrayBuffer().then(payload => {
      const r = new Utils.Reader([...new Uint8Array(payload)])
      const nOutpoints = r.readVarIntNum()
      if (nOutpoints > 256) throw new LookupValidationError('malformed')
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
      return this.extractAtomicOutputs(outpoints, beefObj).then(outputs => ({
        type: 'output-list',
        outputs
      }))
    })
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

type LookupQueryEvent =
  { kind: 'answer'; answer: LookupAnswer } | { kind: 'done' } | { kind: 'grace' } | { kind: 'soft' }

interface LookupQuerySessionOptions {
  hostCount: number
  graceMs: number
  softTimeoutMs?: number
  waitForAllHosts: boolean
  correlationId?: string
  discoveryComplete: boolean
  resolveTxId: (output: LookupAnswer['outputs'][number], now: number) => string | null
}

class LookupQuerySession {
  readonly startedAt = Date.now()
  readonly hostCount: number
  readonly correlationId?: string
  completedHosts = 0
  successfulHosts = 0
  emptyHosts = 0
  failedHosts = 0
  rejectedHosts = 0
  freeformHosts = 0
  emittedFinal = false

  private readonly discoveryComplete: boolean
  private readonly graceMs: number
  private readonly softTimeoutMs?: number
  private readonly waitForAllHosts: boolean
  private readonly resolveTxId: LookupQuerySessionOptions['resolveTxId']
  private readonly outputsMap = new Map<
    string,
    { beef: number[]; context?: number[]; outputIndex: number }
  >()
  private readonly txIds: string[] = []
  private readonly queue: LookupQueryEvent[] = []
  private waiter: (() => void) | null = null
  private answered = false
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private softTimer: ReturnType<typeof setTimeout> | null = null
  private graceFired = false
  private emittedOnce = false

  constructor(options: LookupQuerySessionOptions) {
    this.hostCount = options.hostCount
    this.discoveryComplete = options.discoveryComplete
    this.graceMs = options.graceMs
    this.softTimeoutMs = options.softTimeoutMs
    this.waitForAllHosts = options.waitForAllHosts
    this.correlationId = options.correlationId
    this.resolveTxId = options.resolveTxId
  }

  private push(event: LookupQueryEvent): void {
    this.queue.push(event)
    if (this.waiter === null) return
    const waiter = this.waiter
    this.waiter = null
    waiter()
  }

  recordOutputAnswer(answer: LookupAnswer): void {
    this.successfulHosts++
    if (answer.outputs.length === 0) {
      this.emptyHosts++
      return
    }
    this.push({ kind: 'answer', answer })
  }

  recordFreeformAnswer(): void {
    this.freeformHosts++
  }

  recordRejection(): void {
    this.rejectedHosts++
  }

  recordAvailabilityFailure(): void {
    this.failedHosts++
  }

  recordDone(): void {
    this.completedHosts++
    this.push({ kind: 'done' })
  }

  private mergeAnswer(answer: LookupAnswer): boolean {
    let added = false
    const now = Date.now()
    for (const output of answer.outputs) {
      const txId = this.resolveTxId(output, now)
      if (txId === null) continue
      const key = `${txId}.${output.outputIndex}`
      if (this.outputsMap.has(key)) continue
      this.outputsMap.set(key, output)
      this.txIds.push(txId)
      added = true
    }
    return added
  }

  private completionStatus(): LookupAnswerProgress['status'] {
    if (this.successfulHosts === 0) return 'unavailable'
    if (
      this.discoveryComplete &&
      this.completedHosts === this.hostCount &&
      this.successfulHosts === this.hostCount
    )
      return 'complete'
    return 'incomplete'
  }

  snapshot(isFinal: boolean): LookupAnswerProgress {
    return {
      type: 'output-list',
      outputs: Array.from(this.outputsMap.values()),
      txIds: this.txIds.slice(),
      isFinal,
      hostCount: this.hostCount,
      completedHosts: this.completedHosts,
      successfulHosts: this.successfulHosts,
      emptyHosts: this.emptyHosts,
      failedHosts: this.failedHosts,
      rejectedHosts: this.rejectedHosts,
      freeformHosts: this.freeformHosts,
      discoveryComplete: this.discoveryComplete,
      status: this.completionStatus(),
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {})
    }
  }

  private handleAnswer(answer: LookupAnswer): LookupAnswerProgress | null {
    const added = this.mergeAnswer(answer)
    if (!this.answered) {
      this.answered = true
      if (!this.graceFired && this.graceMs > 0) {
        this.graceTimer = setTimeout(() => {
          this.graceFired = true
          this.push({ kind: 'grace' })
        }, this.graceMs)
      } else {
        this.graceFired = true
      }
    }
    if (this.graceFired && added && (this.emittedOnce || !this.waitForAllHosts)) {
      this.emittedOnce = true
      return this.snapshot(false)
    }
    return null
  }

  private handleGrace(): LookupAnswerProgress | null {
    if (this.emittedOnce || this.waitForAllHosts) return null
    this.emittedOnce = true
    return this.snapshot(false)
  }

  private handleSoft(): LookupAnswerProgress | null {
    let snapshot: LookupAnswerProgress | null = null
    if (!this.emittedOnce) {
      this.graceFired = true
      this.emittedOnce = true
      snapshot = this.snapshot(false)
    }
    return snapshot
  }

  private nextEvent(): Promise<LookupQueryEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as LookupQueryEvent)
    return new Promise<void>(resolve => {
      this.waiter = resolve
    }).then(() => this.queue.shift() as LookupQueryEvent)
  }

  private processEvent(event: LookupQueryEvent): LookupAnswerProgress | null {
    switch (event.kind) {
      case 'answer':
        return this.handleAnswer(event.answer)
      case 'grace':
        return this.handleGrace()
      case 'soft':
        return this.handleSoft()
      case 'done':
        return null
    }
  }

  async *progress(): AsyncIterable<LookupAnswerProgress> {
    if (typeof this.softTimeoutMs === 'number' && this.softTimeoutMs >= 0) {
      this.softTimer = setTimeout(() => this.push({ kind: 'soft' }), this.softTimeoutMs)
    }
    try {
      while (this.completedHosts < this.hostCount || this.queue.length > 0) {
        const event = await this.nextEvent()
        const outcome = this.processEvent(event)
        if (outcome != null) yield outcome
      }
      const finalSnapshot = this.snapshot(true)
      this.emittedFinal = true
      yield finalSnapshot
    } finally {
      if (this.graceTimer !== null) clearTimeout(this.graceTimer)
      if (this.softTimer !== null) clearTimeout(this.softTimer)
    }
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
  protected readonly facilitator: OverlayLookupFacilitator
  protected readonly slapTrackers: string[]
  protected readonly hostOverrides: Record<string, string[]>
  protected readonly additionalHosts: Record<string, string[]>
  protected readonly networkPreset: LookupNetworkPreset
  private readonly reputation: ReliableHostReputation
  private readonly telemetry: Telemetry

  private readonly txMemo: Map<string, { txId: string; expiresAt: number }>
  private readonly txMemoTtlMs: number

  /**
   * Records which SLAP tracker most recently advertised each host. Used to
   * attach `advertisedBy` to onUnreachableHost callbacks so downstream
   * notification consumers know which tracker has a stale advertisement.
   */
  private readonly advertisedBy: Map<string, string>
  private readonly notificationTimes: Map<string, number>

  constructor(config: LookupResolverConfig = {}) {
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

    // A legacy get/set-only store cannot safely perform cross-tab read/modify/write.
    // Keep it memory-only unless the caller supplies an atomic v4 store.
    this.reputation = new ReliableHostReputation(
      config.reliableReputationStorage ??
        (typeof config.reputationStorage === 'object' ? null : undefined)
    )
    this.txMemoTtlMs = config.cache?.txMemoTtlMs ?? 10 * 60 * 1000

    this.txMemo = new Map()
    this.advertisedBy = new Map()
    this.notificationTimes = new Map()
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
   * answered (or with a retryable error if no host has answered by `softTimeoutMs`).
   */
  query(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupAnswer> {
    return this.queryDetailed(question, timeout, options).then(resolution => {
      if (resolution.answer.outputs.length === 0 && resolution.progress.status !== 'complete')
        throw new LookupUnavailableError(resolution.progress)
      return resolution.answer
    })
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

  /** Fresh bounded union across trackers; health never removes an eligible candidate. */
  private async resolveHosts(
    question: LookupQuestion,
    signal: AbortSignal,
    remaining: () => number
  ): Promise<{ hosts: string[]; complete: boolean }> {
    let candidates: string[]
    let complete = true
    if (this.hostOverrides[question.service] !== undefined) {
      candidates = this.hostOverrides[question.service].slice()
    } else if (this.networkPreset === 'local') {
      candidates = ['http://localhost:8080']
    } else if (question.service === 'ls_slap') {
      candidates = this.slapTrackers.slice()
    } else {
      const trackers = normalizeHosts(this.slapTrackers, false)
      if (trackers.length === 0 || trackers.length > 32) complete = false
      const answers = await Promise.all(
        trackers.slice(0, 32).map(tracker =>
          requestReliableHost(
            this.facilitator,
            { reputation: this.reputation, network: this.networkPreset },
            tracker,
            { service: 'ls_slap', query: { service: question.service } },
            {
              hostTimeoutMs: MAX_TRACKER_WAIT_TIME,
              validate: answer => {
                if (!isOutputListAnswer(answer)) throw new LookupValidationError('malformed')
                const hosts = this.extractHostsFromAnswer(answer, question.service)
                if (hosts.length !== answer.outputs.length) complete = false
                return hosts
              }
            },
            remaining(),
            signal
          ).then(result => {
            if (result.kind !== 'answer') {
              complete = false
              return []
            }
            for (const host of result.values) {
              if (this.advertisedBy.size >= 512) this.evictOldest(this.advertisedBy)
              this.advertisedBy.set(host, tracker)
            }
            return result.values
          })
        )
      )
      candidates = answers.flat()
    }
    candidates.push(...(this.additionalHosts[question.service] ?? []))
    if (
      candidates.some(host => normalizeHosts([host], this.networkPreset === 'local').length === 0)
    )
      complete = false
    const hosts = normalizeHosts(candidates, this.networkPreset === 'local')
    if (hosts.length === 0 || hosts.length > 32) complete = false
    // Storage is advisory: a blocked browser database must not delay host recovery.
    await withinDeadline(() => this.reputation.refresh(), Math.min(50, remaining()), signal).catch(
      () => {}
    )
    // Select before ranking: persisted health must not exclude a candidate at the cap.
    return {
      hosts: this.reputation.rank(this.networkPreset, question.service, hosts.slice(0, 32)),
      complete
    }
  }

  /** Service-specific verification on the same discovery, scheduling and reputation path. */
  async queryReliable<T>(
    question: LookupQuestion,
    options: ReliableLookupOptions<T>
  ): Promise<ReliableLookupResult<T>> {
    const start = monotonicNow()
    const deadlineMs = boundedMs(options.deadlineMs, 5000)
    boundedMs(options.hostTimeoutMs, DEFAULT_LOOKUP_TIMEOUT)
    const remaining = (): number => Math.max(0, deadlineMs - (monotonicNow() - start))
    const hosts: ReliableLookupResult<T>['hosts'] = []
    let discoveryComplete = false
    try {
      await withinDeadline(
        signal =>
          this.resolveHosts(question, signal, remaining).then(discovery => {
            discoveryComplete = discovery.complete
            return Promise.all(
              discovery.hosts.map(host =>
                requestReliableHost(
                  this.facilitator,
                  { reputation: this.reputation, network: this.networkPreset },
                  host,
                  question,
                  {
                    ...options,
                    validate: (answer, child) => {
                      if (!isOutputListAnswer(answer)) throw new LookupValidationError('malformed')
                      return options.validate(answer, child)
                    }
                  },
                  remaining(),
                  signal
                ).then(outcome => {
                  hosts.push(outcome)
                })
              )
            )
          }),
        deadlineMs,
        options.signal
      )
    } catch {
      discoveryComplete = false
    }
    return { hosts: hosts.slice(), discoveryComplete, durationMs: monotonicNow() - start }
  }

  private notificationCooldown(options: LookupQueryOptions | undefined): number {
    const requested = options?.unreachableHostNotificationCooldownMs
    return typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
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
      this.notificationTimes.get(notificationKey) ?? Number.NEGATIVE_INFINITY
    if (now - lastNotificationAt < cooldownMs) return
    if (this.notificationTimes.size >= MAX_NOTIFICATION_DEDUP_ENTRIES) {
      this.evictOldest(this.notificationTimes)
    }
    this.notificationTimes.set(notificationKey, now)
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

  private recordAnswer(
    session: LookupQuerySession,
    service: string,
    host: string,
    answer: LookupFacilitatorAnswer,
    hostStartedAt: number,
    correlationId: string | undefined
  ): void {
    let outcome: 'empty' | 'success' | 'freeform' = 'freeform'
    if (isOutputListAnswer(answer)) {
      session.recordOutputAnswer(answer)
      outcome = answer.outputs.length === 0 ? 'empty' : 'success'
    } else session.recordFreeformAnswer()
    this.captureHost(service, host, outcome, Date.now() - hostStartedAt, correlationId)
  }

  private recordFailure(context: LookupHostFailureContext, error: unknown): void {
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
    this.captureHost(
      service,
      host,
      semanticRejection ? 'rejected' : 'failed',
      Date.now() - hostStartedAt,
      correlationId,
      error
    )
    if (!semanticRejection) {
      this.notifyUnreachableHost(host, service, error, onUnreachableHost, notificationCooldownMs)
    }
  }

  private startQueries(
    hosts: string[],
    question: LookupQuestion,
    timeout: number | undefined,
    session: LookupQuerySession,
    options: LookupQueryOptions | undefined,
    signal: AbortSignal,
    remaining: () => number
  ): void {
    const correlationId = session.correlationId
    const notificationCooldownMs = this.notificationCooldown(options)
    for (const host of hosts) {
      const hostStartedAt = Date.now()
      void this.lookupHost(
        host,
        question,
        Math.min(timeout ?? DEFAULT_LOOKUP_TIMEOUT, remaining()),
        signal
      )
        .then(answer => {
          this.recordAnswer(session, question.service, host, answer, hostStartedAt, correlationId)
        })
        .catch(error => {
          if (signal.aborted) {
            session.recordAvailabilityFailure()
            return
          }
          this.recordFailure(
            {
              session,
              service: question.service,
              host,
              hostStartedAt,
              correlationId,
              onUnreachableHost: options?.onUnreachableHost,
              notificationCooldownMs
            },
            error
          )
        })
        .finally(() => {
          session.recordDone()
        })
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
   *    caller can `break` early to abort outstanding work.
   *
   * Resolver waits are bounded even for non-cooperative facilitators; only cooperative work can actually be aborted.
   */
  async *query$(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): AsyncIterable<LookupAnswerProgress> {
    const startedAt = monotonicNow()
    const deadlineMs = boundedMs(options?.deadlineMs, 5000)
    boundedMs(timeout, DEFAULT_LOOKUP_TIMEOUT)
    const remaining = (): number => Math.max(0, deadlineMs - (monotonicNow() - startedAt))
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const timer = setTimeout(abort, deadlineMs)
    if (options?.signal?.aborted === true) abort()
    else options?.signal?.addEventListener('abort', abort, { once: true })
    let discovery: { hosts: string[]; complete: boolean }
    try {
      discovery = await withinDeadline(
        signal => this.resolveHosts(question, signal, remaining),
        remaining(),
        controller.signal
      )
    } catch {
      discovery = { hosts: [], complete: false }
    }
    const rankedHosts = discovery.hosts
    const hostCount = rankedHosts.length
    const correlationId =
      options?.correlationId ??
      (this.telemetry.enabled ? this.telemetry.createCorrelationId() : undefined)
    const session = new LookupQuerySession({
      hostCount,
      discoveryComplete: discovery.complete,
      graceMs: options?.graceMs ?? 80,
      softTimeoutMs: options?.softTimeoutMs,
      waitForAllHosts: options?.waitForAllHosts ?? options?.holdForUnknownHosts ?? false,
      correlationId,
      resolveTxId: (output, now) => this.resolveTxIdForOutput(output, now)
    })

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

    this.startQueries(
      rankedHosts,
      question,
      timeout,
      session,
      options,
      controller.signal,
      remaining
    )

    try {
      for await (const progress of session.progress()) {
        if (progress.isFinal) {
          this.captureCompletion(question.service, progress, Date.now() - session.startedAt)
        }
        yield progress
      }
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abort)
      controller.abort()
      if (!session.emittedFinal) {
        this.telemetry.capture({
          name: 'sdk.overlay.lookup.cancelled',
          component: 'sdk.lookup-resolver',
          severity: 'debug',
          correlationId,
          attributes: {
            service: question.service,
            hostCount,
            completedHosts: session.completedHosts,
            durationMs: Date.now() - session.startedAt
          }
        })
      }
    }
  }

  /**
   * Extracts competent host domains from a SLAP tracker response.
   */
  protected extractHostsFromAnswer(answer: LookupAnswer, service: string): string[] {
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
   * hint only after it matches Transaction.fromBEEF(beef).id('hex'), memoized by
   * the BEEF byte sequence. Returns null for unparseable BEEF or a mismatched hint.
   */
  private resolveTxIdForOutput(
    output: { txid?: string; beef: number[]; outputIndex: number; context?: number[] },
    now: number
  ): string | null {
    const keyForBeef = Array.isArray(output.beef) ? output.beef.join(',') : ''
    const memo = this.txMemo.get(keyForBeef)
    if (typeof memo === 'object' && memo !== null && memo.expiresAt > now) {
      return output.txid === undefined || output.txid.toLowerCase() === memo.txId ? memo.txId : null
    }
    try {
      const txId = Transaction.fromBEEF(output.beef).id('hex')
      if (output.txid !== undefined && output.txid.toLowerCase() !== txId) return null
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

  private lookupHost(
    host: string,
    question: LookupQuestion,
    timeout: number,
    signal: AbortSignal
  ): Promise<LookupFacilitatorAnswer> {
    let failure: unknown
    return requestReliableHost<LookupFacilitatorAnswer>(
      this.facilitator,
      { reputation: this.reputation, network: this.networkPreset },
      host,
      question,
      {
        hostTimeoutMs: Math.max(1, timeout),
        onError: error => {
          failure = error
        },
        credit: values => values[0]?.type === 'output-list',
        penalizeRejections: false,
        validate: answer => {
          if (!isOutputListAnswer(answer) && !isFreeformAnswer(answer))
            throw new LookupValidationError('malformed')
          if (
            isOutputListAnswer(answer) &&
            answer.outputs.some(output => this.resolveTxIdForOutput(output, Date.now()) === null)
          )
            throw new LookupValidationError('malformed')
          return [answer]
        }
      },
      timeout,
      signal
    ).then(result => {
      if (result.kind === 'answer') return result.values[0]
      if (failure !== undefined) throw failure
      throw new Error(`Lookup response ${result.kind}`)
    })
  }

  private captureHost(
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

  private captureCompletion(
    service: string,
    progress: LookupAnswerProgress,
    durationMs: number
  ): void {
    const degraded = progress.status !== 'complete'
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
