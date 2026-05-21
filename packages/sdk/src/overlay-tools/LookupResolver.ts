import { Transaction } from '../transaction/index.js'
import { Beef } from '../transaction/Beef.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import * as Utils from '../primitives/utils.js'
import { getOverlayHostReputationTracker, HostReputationTracker } from './HostReputationTracker.js'

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

/**
 * How the Overlay Services Engine responds to a Lookup Question.
 * It may comprise either an output list or a freeform response from the Lookup Service.
 */
export type LookupAnswer =
  | {
    type: 'output-list'
    outputs: Array<{
      beef: number[]
      outputIndex: number
      context?: number[]
      /** Optional txid hint. When present, consumers can skip re-parsing beef to derive the txid. */
      txid?: string
    }>
  }

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
}

/**
 * One emission from {@link LookupResolver.query$}. Carries the cumulative output set discovered so far
 * plus a small envelope describing progress across hosts. Callers can render fast on the first emission
 * and refine in place as more hosts answer.
 */
export interface LookupAnswerProgress {
  type: 'output-list'
  outputs: Array<{ beef: number[], outputIndex: number, context?: number[], txid?: string }>
  /** Parallel array of resolved tx ids for each output (same index as `outputs`). */
  txIds: string[]
  /** True only for the final emission, after every in-flight host has settled. */
  isFinal: boolean
  /** Number of ranked hosts that were queried. */
  hostCount: number
  /** Number of hosts that have settled (success / fail / timeout). */
  completedHosts: number
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

/** A wall-clock deadline that rejects after `timeoutMs`, optionally aborting a controller. */
interface Deadline {
  /** Rejects with `Error('Request timed out')` once the timer fires. */
  promise: Promise<never>
  /** Clears the underlying timer. Safe to call after the timer has already fired. */
  cancel: () => void
  /** Returns true once the timer has fired. */
  didTimeOut: () => boolean
}

function createDeadline (timeoutMs: number, controller?: AbortController): Deadline {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      try { controller?.abort() } catch { /* noop */ }
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

function normalizeLookupError (err: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error('Request timed out')
  if ((err as { name?: string })?.name === 'AbortError') return new Error('Request timed out')
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Returns true when the given Content-Type header value represents
 * `application/octet-stream`, ignoring case and any media-type parameters
 * (e.g. `; charset=utf-8`).
 */
function isOctetStream (contentType: string | null): boolean {
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
  reputationStorage?: 'localStorage' | { get: (key: string) => string | null | undefined, set: (key: string, value: string) => void }
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
  ) => Promise<LookupAnswer>
}

export class HTTPSOverlayLookupFacilitator implements OverlayLookupFacilitator {
  fetchClient: typeof fetch
  allowHTTP: boolean

  constructor (httpClient = defaultFetch, allowHTTP: boolean = false) {
    if (typeof httpClient !== 'function') {
      throw new TypeError(
        'HTTPSOverlayLookupFacilitator requires a fetch implementation. ' +
        'In environments without fetch, provide a polyfill or custom implementation.'
      )
    }
    this.fetchClient = httpClient
    this.allowHTTP = allowHTTP
  }

  async lookup (
    url: string,
    question: LookupQuestion,
    timeout: number = 2000
  ): Promise<LookupAnswer> {
    if (!url.startsWith('https:') && !this.allowHTTP) {
      throw new Error(
        'HTTPS facilitator can only use URLs that start with "https:"'
      )
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
    fetchPromise.catch(() => { /* noop */ })

    try {
      return await Promise.race([fetchPromise, deadline.promise])
    } catch (e) {
      throw normalizeLookupError(e, deadline.didTimeOut())
    } finally {
      deadline.cancel()
    }
  }

  private async performLookupRequest (
    url: string,
    question: LookupQuestion,
    signal: AbortSignal | undefined
  ): Promise<LookupAnswer> {
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
    if (!response.ok) throw new Error(`Failed to facilitate lookup (HTTP ${response.status})`)
    if (isOctetStream(response.headers.get('content-type'))) {
      return await this.parseOctetStreamLookup(response)
    }
    return await response.json()
  }

  /** Parse the aggregated octet-stream lookup response into an output-list LookupAnswer. */
  private async parseOctetStreamLookup (response: Response): Promise<LookupAnswer> {
    const payload = await response.arrayBuffer()
    const r = new Utils.Reader([...new Uint8Array(payload)])
    const nOutpoints = r.readVarIntNum()
    const outpoints: Array<{ txid: string, outputIndex: number, context?: number[] }> = []
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
  private async extractAtomicOutputs (
    outpoints: Array<{ txid: string, outputIndex: number, context?: number[] }>,
    beefObj: Beef
  ): Promise<Array<{ outputIndex: number, context?: number[], beef: number[], txid: string }>> {
    const beefByTxid = new Map<string, number[]>()
    const outputs: Array<{ outputIndex: number, context?: number[], beef: number[], txid: string }> = new Array(outpoints.length)
    for (let idx = 0; idx < outpoints.length; idx++) {
      const x = outpoints[idx]
      let beefBytes = beefByTxid.get(x.txid)
      if (beefBytes === undefined) {
        beefBytes = beefObj.toBinaryAtomic(x.txid)
        beefByTxid.set(x.txid, beefBytes)
      }
      outputs[idx] = { outputIndex: x.outputIndex, context: x.context, beef: beefBytes, txid: x.txid }
      // Yield to event loop so UI animations and other JS don't starve.
      if (idx > 0 && idx < outpoints.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
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

  // ---- Caches / memoization ----
  private readonly hostsCache: Map<string, { hosts: string[], expiresAt: number }>
  private readonly hostsInFlight: Map<string, Promise<string[]>>
  private readonly hostsTtlMs: number
  private readonly hostsMaxEntries: number

  private readonly txMemo: Map<string, { txId: string, expiresAt: number }>
  private readonly txMemoTtlMs: number

  constructor (config: LookupResolverConfig = {}) {
    this.networkPreset = config.networkPreset ?? 'mainnet'
    this.facilitator = config.facilitator ?? new HTTPSOverlayLookupFacilitator(undefined, this.networkPreset === 'local')
    this.slapTrackers = config.slapTrackers ?? (this.networkPreset === 'mainnet' ? DEFAULT_SLAP_TRACKERS : DEFAULT_TESTNET_SLAP_TRACKERS)
    const hostOverrides = config.hostOverrides ?? {}
    this.assertValidOverrideServices(hostOverrides)
    this.hostOverrides = hostOverrides
    this.additionalHosts = config.additionalHosts ?? {}

    const rs = config.reputationStorage
    if (rs === 'localStorage') {
      this.hostReputation = new HostReputationTracker()
    } else if (typeof rs === 'object' && rs !== null && typeof rs.get === 'function' && typeof rs.set === 'function') {
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
  }

  /**
   * Given a LookupQuestion, returns a LookupAnswer. Aggregates across multiple services and supports resiliency.
   *
   * Optional `options.graceMs` overrides the per-call grace window (default 80 ms).
   * Optional `options.softTimeoutMs` resolves the query early with whatever has arrived once any host has
   * answered (or with an empty result if no host has answered by `softTimeoutMs`).
   */
  async query (
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupAnswer> {
    // Existing fast-but-narrow contract: return at the first cumulative emission
    // (the post-grace aggregate, or the final emission when every host settles
    // before the grace window). Callers wanting progressive enrichment use query$().
    // Take only the first emission, then explicitly close the iterator so the
    // generator's `finally` block runs and clears any outstanding timers.
    const iter = this.query$(question, timeout, options)[Symbol.asyncIterator]()
    let last: LookupAnswerProgress | null = null
    try {
      const { value, done } = await iter.next()
      if (done !== true && value != null) last = value
    } finally {
      await iter.return?.(undefined)
    }
    return {
      type: 'output-list',
      outputs: last?.outputs ?? []
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
  async * query$ (
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): AsyncIterable<LookupAnswerProgress> {
    let competentHosts: string[] = []
    if (question.service === 'ls_slap') {
      competentHosts = this.networkPreset === 'local' ? ['http://localhost:8080'] : this.slapTrackers
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

    const rankedHosts = this.prepareHostsForQuery(
      competentHosts,
      `lookup service ${question.service}`
    )
    if (rankedHosts.length < 1) {
      throw new Error(`All competent hosts for ${question.service} are temporarily unavailable due to backoff.`)
    }

    const graceMs = options?.graceMs ?? 80
    const softTimeoutMs = options?.softTimeoutMs

    const hostCount = rankedHosts.length
    const outputsMap = new Map<string, { beef: number[], context?: number[], outputIndex: number }>()
    const txIds: string[] = []
    let completedHosts = 0
    let firstResponseAt: number | null = null

    type Event = { kind: 'answer', answer: LookupAnswer } | { kind: 'done' } | { kind: 'soft' }
    const queue: Event[] = []
    let waiter: ((v: void) => void) | null = null
    const push = (e: Event): void => {
      queue.push(e)
      if (waiter !== null) {
        const w = waiter
        waiter = null
        w()
      }
    }

    for (const host of rankedHosts) {
      this.lookupHostWithTracking(host, question, timeout)
        .then((answer) => {
          if (answer?.type === 'output-list' && Array.isArray(answer.outputs) && answer.outputs.length > 0) {
            push({ kind: 'answer', answer })
          }
        })
        .catch(() => { /* tracked already */ })
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
      completedHosts
    })

    try {
      while (completedHosts < hostCount) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { waiter = resolve })
        }
        const e = queue.shift() as Event
        if (e.kind === 'answer') {
          const added = mergeAnswer(e.answer)
          if (firstResponseAt === null) {
            firstResponseAt = Date.now()
            if (!graceFired && graceMs > 0) {
              graceTimer = setTimeout(() => {
                graceFired = true
                push({ kind: 'soft' })
              }, graceMs)
            } else {
              graceFired = true
            }
          }
          if (graceFired && added) {
            emittedOnce = true
            yield snapshot(false)
          }
        } else if (e.kind === 'soft') {
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
          // continue loop; final emission happens after the loop
        }
      }
      yield snapshot(true)
    } finally {
      if (graceTimer !== null) clearTimeout(graceTimer)
      if (softTimer !== null) clearTimeout(softTimer)
    }
  }

  /**
   * Cached wrapper for competent host discovery with stale-while-revalidate.
   */
  private async getCompetentHostsCached (service: string): Promise<string[]> {
    const now = Date.now()
    const cached = this.hostsCache.get(service)

    // if fresh, return immediately
    if (typeof cached === 'object' && cached.expiresAt > now) {
      return cached.hosts.slice()
    }

    // if stale but present, kick off a refresh if not already in-flight and return stale
    if (typeof cached === 'object' && cached.expiresAt <= now) {
      if (!this.hostsInFlight.has(service)) {
        this.hostsInFlight.set(service, this.refreshHosts(service).finally(() => {
          this.hostsInFlight.delete(service)
        }))
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
  private async refreshHosts (service: string): Promise<string[]> {
    const hosts = await this.findCompetentHosts(service)
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
  private extractHostsFromAnswer (answer: LookupAnswer, service: string): string[] {
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
  private async findCompetentHosts (service: string): Promise<string[]> {
    const query: LookupQuestion = {
      service: 'ls_slap',
      query: { service }
    }

    const trackerHosts = this.prepareHostsForQuery(
      this.slapTrackers,
      'SLAP trackers'
    )
    if (trackerHosts.length === 0) return []

    // Fire all trackers, resolve as soon as any returns valid hosts.
    // Remaining trackers continue in the background for reputation tracking.
    return await new Promise<string[]>((resolve) => {
      const allHosts = new Set<string>()
      let resolved = false
      let pending = trackerHosts.length

      for (const tracker of trackerHosts) {
        this.lookupHostWithTracking(tracker, query, MAX_TRACKER_WAIT_TIME)
          .then((answer) => {
            const hosts = this.extractHostsFromAnswer(answer, service)
            for (const h of hosts) allHosts.add(h)
            if (!resolved && allHosts.size > 0) {
              resolved = true
              resolve([...allHosts])
            }
          })
          .catch(() => { /* tracker failure tracked in reputation */ })
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
  private resolveTxIdForOutput (
    output: { txid?: string, beef: number[], outputIndex: number, context?: number[] },
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

  private assertValidOverrideServices (overrides: Record<string, string[]>): void {
    for (const service of Object.keys(overrides)) {
      if (!service.startsWith('ls_')) {
        throw new Error(`Host override service names must start with "ls_": ${service}`)
      }
    }
  }

  private prepareHostsForQuery (hosts: string[], context: string): string[] {
    if (hosts.length === 0) return []
    const now = Date.now()
    const ranked = this.hostReputation.rankHosts(hosts, now)
    const available = ranked.filter((h) => h.backoffUntil <= now).map((h) => h.host)
    if (available.length > 0) return available

    const soonest = Math.min(...ranked.map((h) => h.backoffUntil))
    const waitMs = Math.max(soonest - now, 0)
    throw new Error(
      `All ${context} hosts are backing off for approximately ${waitMs}ms due to repeated failures.`
    )
  }

  private async lookupHostWithTracking (
    host: string,
    question: LookupQuestion,
    timeout?: number
  ): Promise<LookupAnswer> {
    const startedAt = Date.now()
    try {
      const answer = await this.facilitator.lookup(host, question, timeout)
      const latency = Date.now() - startedAt
      const isValid =
        typeof answer === 'object' &&
        answer !== null &&
        answer.type === 'output-list' &&
        Array.isArray((answer).outputs)

      if (isValid) {
        this.hostReputation.recordSuccess(host, latency)
      } else {
        this.hostReputation.recordFailure(host, 'Invalid lookup response')
      }

      return answer
    } catch (err) {
      this.hostReputation.recordFailure(host, err)
      throw err
    }
  }
}
