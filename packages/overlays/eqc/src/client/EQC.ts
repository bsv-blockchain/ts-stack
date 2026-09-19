import {
  Random,
  Utils,
  type LookupAnswer,
  type LookupQuestion,
  type WalletInterface
} from '@bsv/sdk'

import {
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery,
  type Attestation,
  type Delivery
} from '../protocol/attestation.js'
import { EQCError } from '../protocol/errors.js'
import { sumOfWeights } from '../protocol/fibonacci.js'
import type { HostParams } from '../protocol/params.js'
import {
  decodeMessageList,
  rebuildLookupAnswer,
  type CanonicalMessage
} from '../protocol/payloads.js'
import {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  type EconomicQuery
} from '../protocol/query.js'
import { assessConsistency, classifyMinority, type TopicConsistency } from './consistency.js'
import {
  HostDiscovery,
  discoveryTarget,
  type DiscoveredHost,
  type DiscoveryOptions
} from './discovery.js'
import { decideRace, runRace, type Arrival, type Rejection } from './race.js'
import { InMemoryReputationStore, type ReputationStore } from './reputation.js'
import { planPayouts, settle, type PayoutPlan, type Settlement } from './settlement.js'
import {
  AuthFetchTransport,
  TransportTimeoutError,
  type HostTransport,
  type TransportResponse
} from './transport.js'

export interface EQCOptions extends DiscoveryOptions {
  threshold?: number
  topK?: number
  raceMs?: number
  floorFeeSats?: number
  maxFeeSats?: number
  /** A fee to offer above the floor. It is still capped by `maxFeeSats`. */
  feeSats?: number
  queryTtlMs?: number
  hostTimeoutMs?: number
  paramsTtlMs?: number
  /** Most hosts contacted per query, best reputation first. */
  maxHosts?: number
  reputation?: ReputationStore
  transport?: HostTransport
  originator?: string
  /** Monotonic milliseconds for arrival stamps. `now` is wall-clock time. */
  clock?: () => number
}

export type QueryOverrides = Pick<
  EQCOptions,
  'threshold' | 'topK' | 'raceMs' | 'floorFeeSats' | 'maxFeeSats' | 'feeSats'
>

export interface QueryRequest {
  type: string
  params: Record<string, unknown>
}

export interface RankedHost {
  host: string
  url: string
  rank: number
  /** Milliseconds behind the fastest ranked host, as measured by this client. */
  arrivalMs: number
  payoutSats: number
}

export interface QueryResult {
  queryId: string
  contentHash: string
  payload: number[]
  supplement: number[]
  ranking: RankedHost[]
  txid: string
  feeSats: number
  attestations: Attestation[]
  consistency: TopicConsistency[]
  /** Grows until `completion` resolves, as the remaining collects finish. */
  rejected: Rejection[]
  completion: Promise<void>
}

interface Market {
  threshold: number
  topK: number
  raceMs: number
  floorFeeSats: number
  maxFeeSats: number
  feeSats: number
}

interface Candidate {
  host: DiscoveredHost
  params: HostParams
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

/**
 * Economic Query Client for BRC-178. Discovers hosts from SLAP trackers, asks all of them the
 * same authenticated query, ranks their attestations by local arrival time, pays the fastest
 * hosts that agree from one transaction, and returns bytes whose hash it verified.
 */
export class EQC {
  private readonly wallet: WalletInterface
  private readonly options: EQCOptions
  private readonly discovery: HostDiscovery
  private readonly transport: HostTransport
  private readonly reputation: ReputationStore
  private readonly clock: () => number
  private readonly now: () => number
  private readonly paramsCache = new Map<string, { params?: HostParams; expiresAt: number }>()
  private identity: Promise<string> | undefined

  constructor(wallet: WalletInterface, options: EQCOptions = {}) {
    this.wallet = wallet
    this.options = options
    this.market({})
    this.discovery = new HostDiscovery(options)
    this.transport =
      options.transport ?? new AuthFetchTransport(wallet, { originator: options.originator })
    this.reputation = options.reputation ?? new InMemoryReputationStore()
    this.clock = options.clock ?? (() => performance.now())
    this.now = options.now ?? Date.now
  }

  /** Races an overlay lookup and rebuilds the `LookupAnswer` from the verified bytes. */
  async lookup(question: LookupQuestion, overrides: QueryOverrides = {}): Promise<LookupAnswer> {
    const result = await this.query(
      { type: 'overlay-lookup', params: { service: question.service, query: question.query } },
      overrides
    )
    return rebuildLookupAnswer(result.payload, result.supplement)
  }

  /** Races the caller's own message box listing. */
  async listMessages(
    args: { messageBox: string },
    overrides: QueryOverrides = {}
  ): Promise<CanonicalMessage[]> {
    const recipient = await this.identityKey()
    const result = await this.query(
      { type: 'message-list', params: { recipient, messageBox: args.messageBox } },
      overrides
    )
    return decodeMessageList(result.payload)
  }

  /** Reads and caches a host's unauthenticated `/economic/params`. */
  async params(url: string): Promise<HostParams> {
    const cached = this.paramsCache.get(url)
    if (cached !== undefined && this.now() < cached.expiresAt) {
      if (cached.params === undefined) throw new Error(`${url} has no economic params`)
      return cached.params
    }
    const expiresAt = this.now() + (this.options.paramsTtlMs ?? DEFAULTS.paramsTtlMs)
    try {
      const params = await this.transport.getParams(url, this.hostTimeoutMs())
      this.paramsCache.set(url, { params, expiresAt })
      return params
    } catch (error) {
      this.paramsCache.set(url, { expiresAt })
      throw error
    }
  }

  async query(request: QueryRequest, overrides: QueryOverrides = {}): Promise<QueryResult> {
    const market = this.market(overrides)
    const client = await this.identityKey()
    const rejected: Rejection[] = []
    const candidates = await this.candidates(request, client, market, rejected)
    if (candidates.length < market.threshold) {
      throw new EQCError(
        'ERR_EQC_NO_HOSTS',
        `${candidates.length} market hosts are available but the threshold is ${market.threshold}`,
        { rejected }
      )
    }

    const query = this.buildQuery(request, client, market, candidates)
    const queryId = computeQueryId(query)
    const race = await runRace(
      candidates.map(candidate => ({
        url: candidate.host.url,
        promise: this.attest(candidate.host, query, queryId)
      })),
      { raceMs: market.raceMs, hostTimeoutMs: this.hostTimeoutMs(), topK: market.topK }
    )
    for (const rejection of race.rejections) this.reject(rejected, rejection)
    for (const url of race.unfinished) {
      this.reject(rejected, { url, reason: race.arrivals.length > 0 ? 'late' : 'timeout' })
    }
    if (race.arrivals.length === 0) {
      throw new EQCError('ERR_EQC_NO_ATTESTATION', 'No host returned a valid attestation', {
        rejected
      })
    }

    const outcome = decideRace(race.arrivals, market)
    if (!outcome.thresholdMet || outcome.winningHash === undefined) {
      throw new EQCError(
        'ERR_EQC_THRESHOLD',
        `No content hash was attested by ${market.threshold} hosts; nothing was paid`,
        { groups: outcome.groups, consistency: assessConsistency(race.arrivals), rejected }
      )
    }
    for (const minority of outcome.minority) {
      const classification = classifyMinority(minority, outcome.ranked)
      this.reputation.record(minority.url, classification, this.now())
      rejected.push({
        url: minority.url,
        host: minority.host,
        reason: 'minority-hash',
        detail: classification
      })
    }

    const quotes = outcome.ranked
      .map(arrival => arrival.attestation.quotedFeeSats)
      .filter(quote => quote <= market.maxFeeSats)
    const feeSats = Math.min(
      market.maxFeeSats,
      Math.max(query.floorFeeSats, market.feeSats, sumOfWeights(outcome.ranked.length), ...quotes)
    )
    const plans = planPayouts(outcome.ranked, feeSats)
    let settlement: Settlement
    try {
      settlement = await settle(this.wallet, queryId, plans, this.options.originator)
    } catch (error) {
      throw new EQCError('ERR_EQC_PAYMENT', 'The wallet could not create the payout transaction', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    const contentHash = outcome.winningHash
    const ranking = outcome.ranked.map(arrival => arrival.host)
    const validate = request.type === 'overlay-lookup' ? rebuildLookupAnswer : undefined
    const attempts = plans.map(
      async plan =>
        await this.collect(plan, settlement, { queryId, contentHash, ranking }, rejected, validate)
    )
    const completion = Promise.allSettled(attempts).then(() => undefined)
    let delivered: { payload: number[]; supplement: number[] }
    try {
      delivered = await Promise.any(attempts)
    } catch {
      await completion
      throw new EQCError(
        'ERR_EQC_UNDELIVERED',
        'The payout was dispatched but no host delivered the attested bytes',
        { txid: settlement.txid, rejected }
      )
    }

    const firstArrival = outcome.ranked[0].arrivedAt
    return {
      queryId,
      contentHash,
      payload: delivered.payload,
      supplement: delivered.supplement,
      ranking: outcome.ranked.map((arrival, index) => ({
        host: arrival.host,
        url: arrival.url,
        rank: index + 1,
        arrivalMs: arrival.arrivedAt - firstArrival,
        payoutSats: plans.find(plan => plan.rank === index + 1)?.satoshis ?? 0
      })),
      txid: settlement.txid,
      feeSats,
      attestations: race.arrivals.map(arrival => arrival.attestation),
      consistency: assessConsistency(outcome.ranked),
      rejected,
      completion
    }
  }

  private market(overrides: QueryOverrides): Market {
    const pick = (name: keyof QueryOverrides, fallback: number): number =>
      overrides[name] ?? this.options[name] ?? fallback
    const threshold = boundedInteger(
      pick('threshold', DEFAULTS.threshold),
      'threshold',
      1,
      MAX_RANKED_HOSTS
    )
    const topK = boundedInteger(pick('topK', DEFAULTS.topK), 'topK', 1, MAX_RANKED_HOSTS)
    if (threshold > 1 && topK < threshold) {
      throw new RangeError('topK must be at least threshold unless threshold is 1')
    }
    const market: Market = {
      threshold,
      topK,
      raceMs: boundedInteger(pick('raceMs', DEFAULTS.raceMs), 'raceMs', 0, 60_000),
      floorFeeSats: boundedInteger(
        pick('floorFeeSats', DEFAULTS.floorFeeSats),
        'floorFeeSats',
        1,
        Number.MAX_SAFE_INTEGER
      ),
      maxFeeSats: boundedInteger(
        pick('maxFeeSats', DEFAULTS.maxFeeSats),
        'maxFeeSats',
        1,
        Number.MAX_SAFE_INTEGER
      ),
      feeSats: boundedInteger(pick('feeSats', 0), 'feeSats', 0, Number.MAX_SAFE_INTEGER)
    }
    if (market.floorFeeSats > market.maxFeeSats) {
      throw new EQCError(
        'ERR_EQC_BUDGET',
        `floorFeeSats ${market.floorFeeSats} exceeds maxFeeSats ${market.maxFeeSats}`
      )
    }
    return market
  }

  private hostTimeoutMs(): number {
    return this.options.hostTimeoutMs ?? DEFAULTS.hostTimeoutMs
  }

  private async identityKey(): Promise<string> {
    this.identity ??= this.wallet
      .getPublicKey({ identityKey: true }, this.options.originator)
      .then(result => result.publicKey)
    return await this.identity
  }

  private reject(rejected: Rejection[], rejection: Rejection): void {
    rejected.push(rejection)
    this.reputation.record(rejection.url, rejection.reason, this.now())
  }

  /** Discovery is free; hosts are then filtered by reputation, market support, and budget. */
  private async candidates(
    request: QueryRequest,
    client: string,
    market: Market,
    rejected: Rejection[]
  ): Promise<Candidate[]> {
    const discovered = await this.discovery.hostsFor(
      discoveryTarget(request.type, request.params, client)
    )
    const now = this.now()
    const usable = discovered
      .filter(host => !this.reputation.isExcluded(host.url, now))
      .sort((left, right) => this.reputation.score(right.url) - this.reputation.score(left.url))
      .slice(0, this.options.maxHosts ?? DEFAULTS.maxHosts)
    const checked = await Promise.all(
      usable.map(async host => {
        try {
          return { host, params: await this.params(host.url) }
        } catch {
          rejected.push({ url: host.url, reason: 'http', detail: 'no economic params' })
          return undefined
        }
      })
    )
    return checked.filter(
      (candidate): candidate is Candidate =>
        candidate !== undefined &&
        candidate.params.classes.includes(request.type) &&
        candidate.params.floorFeeSats <= market.maxFeeSats
    )
  }

  private buildQuery(
    request: QueryRequest,
    client: string,
    market: Market,
    candidates: Candidate[]
  ): EconomicQuery {
    const hint = [
      ...new Set(candidates.map(candidate => candidate.host.identityKey ?? candidate.params.host))
    ]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, 64)
    return {
      type: request.type,
      client,
      hostSetHint: hint,
      params: request.params,
      maxFeeSats: market.maxFeeSats,
      floorFeeSats: Math.max(
        market.floorFeeSats,
        ...candidates.map(candidate => candidate.params.floorFeeSats)
      ),
      threshold: market.threshold,
      topK: market.topK,
      raceMs: market.raceMs,
      expires: new Date(
        this.now() + (this.options.queryTtlMs ?? DEFAULTS.queryTtlMs)
      ).toISOString(),
      nonce: Utils.toHex(Random(32))
    }
  }

  /** Never rejects: a failing host becomes a `Rejection` so it cannot fail the query. */
  private async attest(
    host: DiscoveredHost,
    query: EconomicQuery,
    queryId: string
  ): Promise<Arrival | Rejection> {
    const { url } = host
    try {
      const response = await this.transport.post(
        url,
        ECONOMIC_PATHS.query,
        query,
        this.hostTimeoutMs()
      )
      const arrivedAt = this.clock()
      if (response.status !== 200)
        return { url, reason: 'http', detail: `status ${response.status}` }
      let attestation: Attestation
      try {
        attestation = parseAttestation(response.body)
      } catch (error) {
        return { url, reason: 'malformed', detail: error instanceof Error ? error.message : '' }
      }
      const sessionKey = response.identityKey
      if (
        sessionKey === undefined ||
        (host.identityKey !== undefined && host.identityKey !== sessionKey)
      ) {
        return { url, host: attestation.host, reason: 'identity-mismatch' }
      }
      const verdict = verifyAttestation(attestation, { queryId, host: sessionKey })
      if (verdict === 'ok') return { url, host: sessionKey, attestation, arrivedAt }
      return {
        url,
        host: attestation.host,
        reason: verdict === 'hash-mismatch' ? 'malformed' : verdict
      }
    } catch (error) {
      return {
        url,
        reason: error instanceof TransportTimeoutError ? 'timeout' : 'http',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Resolves with verified bytes or throws after recording why this host failed. */
  private async collect(
    plan: PayoutPlan,
    settlement: Settlement,
    committed: { queryId: string; contentHash: string; ranking: string[] },
    rejected: Rejection[],
    validate?: (payload: number[], supplement: number[]) => unknown
  ): Promise<{ payload: number[]; supplement: number[] }> {
    const fail = (reason: Rejection['reason'], detail?: string): never => {
      const rejection: Rejection = { url: plan.url, host: plan.host, reason }
      if (detail !== undefined) rejection.detail = detail
      this.reject(rejected, rejection)
      throw new Error(`${plan.url}: ${reason}`)
    }
    let response: TransportResponse
    try {
      response = await this.transport.post(
        plan.url,
        ECONOMIC_PATHS.collect,
        {
          type: 'collect',
          queryId: committed.queryId,
          contentHash: committed.contentHash,
          ranking: committed.ranking,
          payment: settlement.envelopes.get(plan.host)
        },
        this.hostTimeoutMs()
      )
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : String(error))
    }
    if (response.status !== 200) return fail('collect-failed', `status ${response.status}`)
    if (response.identityKey !== plan.host) return fail('identity-mismatch')
    let delivery: Delivery
    try {
      delivery = parseDelivery(response.body)
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : '')
    }
    const result = verifyDelivery(delivery, {
      queryId: committed.queryId,
      host: plan.host,
      contentHash: committed.contentHash
    })
    if (result.verdict !== 'ok') return fail(result.verdict)
    try {
      validate?.(result.payload, result.supplement)
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : 'invalid supplement')
    }
    this.reputation.record(plan.url, 'success', this.now())
    return { payload: result.payload, supplement: result.supplement }
  }
}
