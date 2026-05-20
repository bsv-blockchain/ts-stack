import { Transaction } from '../transaction/index.js'
import { Beef } from '../transaction/Beef.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import * as Utils from '../primitives/utils.js'
import { getOverlayHostReputationTracker, HostReputationTracker } from './HostReputationTracker.js'
import { plog, pstart } from '../debug/profiler.js'

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

    const span = pstart(`facilitator.lookup ${url}`, { service: question.service, timeout })

    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
    const timer = setTimeout(() => {
      try { controller?.abort() } catch { /* noop */ }
    }, timeout)

    try {
      const fco: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aggregation': 'yes'
        },
        body: JSON.stringify({ service: question.service, query: question.query }),
        signal: controller?.signal
      }
      span.mark('fetch start')
      const response: Response = await this.fetchClient(`${url}/lookup`, fco)
      span.mark('fetch headers', { status: response.status, contentType: response.headers.get('content-type') })

      if (!response.ok) throw new Error(`Failed to facilitate lookup (HTTP ${response.status})`)
      if (response.headers.get('content-type') === 'application/octet-stream') {
        const payload = await response.arrayBuffer()
        span.mark('body arrayBuffer', { bytes: payload.byteLength })
        const r = new Utils.Reader([...new Uint8Array(payload)])
        const nOutpoints = r.readVarIntNum()
        span.mark('parsed outpoint count', { nOutpoints })
        const outpoints: Array<{ txid: string, outputIndex: number, context?: number[] }> = []
        for (let i = 0; i < nOutpoints; i++) {
          const txid = Utils.toHex(r.read(32))
          const outputIndex = r.readVarIntNum()
          const contextLength = r.readVarIntNum()
          let context
          if (contextLength > 0) {
            context = r.read(contextLength)
          }
          outpoints.push({
            txid,
            outputIndex,
            context
          })
        }
        const beef = r.read()
        span.mark('outpoints + BEEF read', { beefBytes: beef.length })

        // Parse the aggregated BEEF blob ONCE and extract per-txid atomic slices.
        // This avoids re-parsing the full blob for every output (dominant cost on device).
        const t0parse = Date.now()
        const beefObj = Beef.fromBinary(beef)
        span.mark('Beef.fromBinary done', { ms: Date.now() - t0parse, txCount: beefObj.txs.length })

        // Memoize per-txid extraction: duplicate txids in the wire outpoints list skip re-extraction.
        const beefByTxid = new Map<string, number[]>()
        const outputs: Array<{ outputIndex: number, context?: number[], beef: number[], txid: string }> = new Array(outpoints.length)
        let reusedCount = 0
        const yieldEvery = 1 // yield every output to keep the event loop responsive
        for (let idx = 0; idx < outpoints.length; idx++) {
          const x = outpoints[idx]
          let beefBytes = beefByTxid.get(x.txid)
          if (beefBytes === undefined) {
            const t0 = Date.now()
            beefBytes = beefObj.toBinaryAtomic(x.txid)
            beefByTxid.set(x.txid, beefBytes)
            const dt = Date.now() - t0
            if (dt > 50) plog(`  facilitator.lookup BEEF decode slow output #${idx}`, { ms: dt, txid: x.txid, beefBytes: beefBytes.length })
          } else {
            reusedCount++
          }
          outputs[idx] = {
            outputIndex: x.outputIndex,
            context: x.context,
            beef: beefBytes,
            txid: x.txid
          }
          // Yield to event loop so UI animations and other JS don't starve.
          if (idx > 0 && (idx % yieldEvery === 0) && idx < outpoints.length - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        }
        span.end({ outputs: outputs.length, uniqueTxs: beefByTxid.size, reusedCount })
        return {
          type: 'output-list',
          outputs
        }
      } else {
        const body = await response.json()
        span.end({ jsonBody: true })
        return body
      }
    } catch (e) {
      // Normalize timeouts to a consistent error message
      if ((e as { name?: string })?.name === 'AbortError') {
        span.end({ aborted: true })
        throw new Error('Request timed out')
      }
      span.end({ error: (e as Error)?.message ?? String(e) })
      throw e
    } finally {
      clearTimeout(timer)
    }
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
    const span = pstart(`LookupResolver.query ${question.service}`, { timeout, options })
    // Existing fast-but-narrow contract: return at the first cumulative emission
    // (the post-grace aggregate, or the final emission when every host settles
    // before the grace window). Callers wanting progressive enrichment use query$().
    // Take only the first emission, then explicitly close the iterator so the
    // generator's `finally` block runs and clears any outstanding timers.
    const iter = this.query$(question, timeout, options)[Symbol.asyncIterator]()
    let last: LookupAnswerProgress | null = null
    try {
      const { value, done } = await iter.next()
      span.mark('first emission', { done, outputs: value?.outputs?.length })
      if (done !== true && value != null) last = value
    } finally {
      await iter.return?.(undefined)
      span.end({ outputs: last?.outputs?.length ?? 0 })
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
    const qSpan = pstart(`LookupResolver.query$ ${question.service}`, { timeout, options })
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
    qSpan.mark('competent hosts resolved', { count: competentHosts.length, hosts: competentHosts })
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
    qSpan.mark('hosts ranked', { rankedHosts })
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

    const beefKey = (beef: number[] | undefined): string => {
      if (typeof beef !== 'object' || beef == null) return ''
      return beef.join(',')
    }

    const mergeAnswer = (answer: LookupAnswer): boolean => {
      const mt0 = Date.now()
      let added = false
      let parseCount = 0
      let parseMs = 0
      let keyMs = 0
      for (const output of answer.outputs) {
        let txId: string
        // Fast path: txid was threaded through from the octet-stream facilitator.
        // Skip the expensive beef-join memo key and Transaction.fromBEEF re-parse.
        if (typeof output.txid === 'string' && output.txid.length > 0) {
          txId = output.txid
        } else {
          // Slow path: JSON response or legacy facilitator without txid hint.
          // Memoize by beef bytes to avoid re-parsing the same blob multiple times.
          const k0 = Date.now()
          const keyForBeef = beefKey(output.beef)
          keyMs += Date.now() - k0
          const now = Date.now()
          let memo = this.txMemo.get(keyForBeef)
          if (typeof memo !== 'object' || memo === null || memo.expiresAt <= now) {
            try {
              const p0 = Date.now()
              txId = Transaction.fromBEEF(output.beef).id('hex')
              parseMs += Date.now() - p0
              parseCount++
              memo = { txId, expiresAt: now + this.txMemoTtlMs }
              if (this.txMemo.size > 4096) this.evictOldest(this.txMemo)
              this.txMemo.set(keyForBeef, memo)
            } catch {
              continue
            }
          } else {
            txId = memo.txId
          }
        }
        const uniqKey = `${txId}.${output.outputIndex}`
        if (!outputsMap.has(uniqKey)) {
          outputsMap.set(uniqKey, output)
          txIds.push(txId)
          added = true
        }
      }
      const total = Date.now() - mt0
      if (total > 20 || parseMs > 20) {
        plog('LookupResolver.mergeAnswer slow', {
          totalMs: total,
          outputs: answer.outputs.length,
          parsedTxs: parseCount,
          parseMs,
          beefKeyJoinMs: keyMs
        })
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
      qSpan.end({ outputs: outputsMap.size, completedHosts, hostCount })
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
    const span = pstart(`LookupResolver.findCompetentHosts ${service}`)
    const query: LookupQuestion = {
      service: 'ls_slap',
      query: { service }
    }

    const trackerHosts = this.prepareHostsForQuery(
      this.slapTrackers,
      'SLAP trackers'
    )
    span.mark('SLAP trackers ranked', { trackerHosts })
    if (trackerHosts.length === 0) { span.end({ result: 'no trackers' }); return [] }

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
            span.mark(`tracker answered ${tracker}`, { hosts: hosts.length })
            for (const h of hosts) allHosts.add(h)
            if (!resolved && allHosts.size > 0) {
              resolved = true
              span.end({ resolvedFromFirst: tracker, hosts: allHosts.size })
              resolve([...allHosts])
            }
          })
          .catch((err) => {
            span.mark(`tracker failed ${tracker}`, { err: (err as Error)?.message })
          })
          .finally(() => {
            pending--
            if (pending === 0 && !resolved) {
              resolved = true
              span.end({ resolvedAfterAll: true, hosts: allHosts.size })
              resolve([...allHosts])
            }
          })
      }
    })
  }

  /** Evict an arbitrary “oldest” entry from a Map (iteration order). */
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

      plog(`lookupHostWithTracking ${host}`, { service: question.service, latencyMs: latency, isValid, outputs: (answer as LookupAnswer)?.outputs?.length })

      if (isValid) {
        this.hostReputation.recordSuccess(host, latency)
      } else {
        this.hostReputation.recordFailure(host, 'Invalid lookup response')
      }

      return answer
    } catch (err) {
      const latency = Date.now() - startedAt
      plog(`lookupHostWithTracking ${host} FAIL`, { service: question.service, latencyMs: latency, err: (err as Error)?.message })
      this.hostReputation.recordFailure(host, err)
      throw err
    }
  }
}
