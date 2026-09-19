import type { WalletInterface } from '@bsv/sdk'

import { signAttestation, signDelivery } from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import { computePayouts } from '../protocol/fibonacci.js'
import type { HostParams } from '../protocol/params.js'
import { parsePaymentEnvelope, type PaymentEnvelope } from '../protocol/payment.js'
import { contentHash } from '../protocol/payloads.js'
import {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  isHashHex,
  isPlainObject,
  isPublicKeyHex,
  validateQuery,
  type EconomicQuery
} from '../protocol/query.js'
import { verifyAndInternalizePayment } from './paymentVerifier.js'
import { InMemoryPendingStore, type PendingStore } from './pendingStore.js'
import type { QueryProvider } from './providers.js'

/** The slice of an express `Request` the handlers read. `auth` is set by BRC-103 middleware. */
export interface HostRequest {
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  auth?: { identityKey?: string }
}

/** The slice of an express `Response` the handlers write. */
export interface HostResponse {
  status(code: number): HostResponse
  json(body: unknown): unknown
  set(name: string, value: string): unknown
}

export type HostHandler = (req: HostRequest, res: HostResponse) => Promise<void>

/** Satisfied by an express `Router` or `Application`. */
export interface RouterLike {
  get(path: string, handler: HostHandler): unknown
  post(path: string, handler: HostHandler): unknown
}

export interface EconomicQueryHostOptions {
  wallet: WalletInterface
  providers: QueryProvider[]
  /** Advertised defaults; the client chooses the values it actually uses. */
  threshold?: number
  topK?: number
  /** Minimum total fee for a query, optionally scaled by canonical payload size. */
  floorFeeSats?: number | ((payloadSize: number) => number)
  /** Smallest output this host serves a collect for, even when its Fibonacci share is smaller. */
  minPayoutSats?: number
  maxQueryTtlMs?: number
  maxPayloadBytes?: number
  store?: PendingStore
  now?: () => number
  originator?: string
  logger?: { error: (...args: unknown[]) => void }
}

export interface EconomicQueryHost {
  params: HostHandler
  query: HostHandler
  collect: HostHandler
  mount: (router: RouterLike) => void
}

interface CollectRequest {
  queryId: string
  contentHash: string
  ranking: string[]
  payment?: PaymentEnvelope
}

const PAYMENT_VERSION = '1.0'
const DEFAULT_MAX_QUERY_TTL_MS = 60_000
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

function paymentRequired(satoshis: number): HostError {
  return new HostError(402, 'ERR_PAYMENT_REQUIRED', `Payment of ${satoshis} satoshis is required`, {
    'x-bsv-payment-version': PAYMENT_VERSION,
    'x-bsv-payment-satoshis-required': String(satoshis)
  })
}

function authenticate(req: HostRequest): string {
  const identityKey = req.auth?.identityKey
  if (!isPublicKeyHex(identityKey)) {
    throw new HostError(401, 'ERR_AUTH_REQUIRED', 'BRC-103 mutual authentication is required')
  }
  return identityKey
}

function parseCollect(req: HostRequest): CollectRequest {
  const invalid = (description: string): HostError =>
    new HostError(400, 'ERR_INVALID_COLLECT', description)
  const body = req.body
  if (!isPlainObject(body) || body.type !== 'collect') {
    throw invalid('Body must be an object of type collect')
  }
  if (!isHashHex(body.queryId) || !isHashHex(body.contentHash)) {
    throw invalid('queryId and contentHash must be 32 bytes of hex')
  }
  const ranking = body.ranking
  if (
    !Array.isArray(ranking) ||
    ranking.length === 0 ||
    ranking.length > MAX_RANKED_HOSTS ||
    !ranking.every(isPublicKeyHex) ||
    new Set(ranking).size !== ranking.length
  ) {
    throw invalid('ranking must list distinct host identity keys')
  }
  let rawPayment: unknown = body.payment
  const header = req.headers['x-bsv-payment']
  if (rawPayment === undefined && typeof header === 'string') {
    try {
      rawPayment = JSON.parse(header)
    } catch {
      throw invalid('x-bsv-payment must be JSON')
    }
  }
  const collect: CollectRequest = {
    queryId: body.queryId,
    contentHash: body.contentHash,
    ranking: [...ranking]
  }
  if (rawPayment !== undefined) {
    try {
      collect.payment = parsePaymentEnvelope(rawPayment)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'Invalid payment')
    }
  }
  return collect
}

export function createEconomicQueryHost(options: EconomicQueryHostOptions): EconomicQueryHost {
  const providers = new Map(options.providers.map(provider => [provider.type, provider]))
  const threshold = options.threshold ?? DEFAULTS.threshold
  const topK = options.topK ?? DEFAULTS.topK
  const minPayoutSats = options.minPayoutSats ?? 1
  const maxQueryTtlMs = options.maxQueryTtlMs ?? DEFAULT_MAX_QUERY_TTL_MS
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  const now = options.now ?? Date.now
  const store = options.store ?? new InMemoryPendingStore({}, now)
  const logger = options.logger ?? console
  const { wallet, originator } = options
  let identity: Promise<string> | undefined

  const hostKey = async (): Promise<string> => {
    identity ??= wallet
      .getPublicKey({ identityKey: true }, originator)
      .then(result => result.publicKey)
    return await identity
  }

  const floorFor = (payloadSize: number): number => {
    const configured = options.floorFeeSats ?? DEFAULTS.floorFeeSats
    const floor = typeof configured === 'function' ? configured(payloadSize) : configured
    if (!Number.isSafeInteger(floor) || floor < 1) {
      throw new Error('floorFeeSats must resolve to a positive safe integer')
    }
    return floor
  }

  const handle =
    (run: (req: HostRequest, res: HostResponse) => Promise<void>): HostHandler =>
    async (req, res) => {
      try {
        await run(req, res)
      } catch (error) {
        if (error instanceof HostError) {
          for (const [name, value] of Object.entries(error.headers)) res.set(name, value)
          res
            .status(error.status)
            .json({ status: 'error', code: error.code, description: error.message })
          return
        }
        logger.error('Economic query handler failed', error)
        res
          .status(500)
          .json({ status: 'error', code: 'ERR_INTERNAL', description: 'Internal error' })
      }
    }

  const readQuery = (req: HostRequest, client: string): EconomicQuery => {
    let query: EconomicQuery
    try {
      query = validateQuery(req.body)
    } catch (error) {
      throw new HostError(
        400,
        'ERR_INVALID_QUERY',
        error instanceof Error ? error.message : 'Invalid query'
      )
    }
    if (query.client !== client) {
      throw new HostError(400, 'ERR_INVALID_QUERY', 'client must be the authenticated identity')
    }
    const expiresAt = Date.parse(query.expires)
    if (expiresAt <= now()) throw new HostError(410, 'ERR_QUERY_EXPIRED', 'The query has expired')
    if (expiresAt > now() + maxQueryTtlMs) {
      throw new HostError(
        400,
        'ERR_INVALID_QUERY',
        `expires may be at most ${maxQueryTtlMs} ms away`
      )
    }
    return query
  }

  const params = handle(async (_req, res) => {
    const body: HostParams = {
      version: 1,
      host: await hostKey(),
      threshold,
      topK,
      floorFeeSats: floorFor(0),
      minPayoutSats,
      maxQueryTtlMs,
      classes: [...providers.keys()]
    }
    res.status(200).json(body)
  })

  const query = handle(async (req, res) => {
    const client = authenticate(req)
    const request = readQuery(req, client)
    const host = await hostKey()
    if (request.strictHosts === true && request.hostSetHint?.includes(host) !== true) {
      throw new HostError(400, 'ERR_INVALID_QUERY', 'This host is not in the strict host set')
    }
    const provider = providers.get(request.type)
    if (provider === undefined) {
      throw new HostError(422, 'ERR_UNSUPPORTED_CLASS', `Query class ${request.type} is not served`)
    }
    const queryId = computeQueryId(request)
    const existing = await store.get(queryId)
    if (existing !== undefined) {
      if (existing.state !== 'pending' || existing.clientIdentityKey !== client) {
        throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
      }
      res.status(200).json(existing.attestation)
      return
    }
    const result = await provider.execute(request, { clientIdentityKey: client })
    if (result.payload.length + (result.supplement?.length ?? 0) > maxPayloadBytes) {
      throw new HostError(413, 'ERR_PAYLOAD_TOO_LARGE', 'The answer exceeds this host limit')
    }
    const floor = floorFor(result.payload.length)
    if (request.maxFeeSats < floor) throw paymentRequired(floor)
    const attestation = await signAttestation(
      wallet,
      {
        queryId,
        host,
        contentHash: contentHash(result.payload),
        payloadSize: result.payload.length,
        quotedFeeSats: floor,
        attestedAt: new Date(now()).toISOString(),
        anchors: result.extensions?.anchors
      },
      originator
    )
    const stored = await store.put({
      queryId,
      query: request,
      clientIdentityKey: client,
      attestation,
      payload: result.payload,
      supplement: result.supplement ?? [],
      expiresAt: Date.parse(request.expires),
      state: 'pending'
    })
    if (stored === 'too-large') {
      throw new HostError(413, 'ERR_PAYLOAD_TOO_LARGE', 'The answer exceeds this host limit')
    }
    if (stored === 'too-many-pending') {
      throw new HostError(429, 'ERR_TOO_MANY_PENDING', 'Too many unsettled queries')
    }
    res.status(200).json(attestation)
  })

  const collect = handle(async (req, res) => {
    const client = authenticate(req)
    const request = parseCollect(req)
    const record = await store.get(request.queryId)
    if (record === undefined || record.clientIdentityKey !== client) {
      throw new HostError(404, 'ERR_QUERY_UNKNOWN', 'No such query for this client')
    }
    if (record.state !== 'pending') {
      throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
    }
    if (record.expiresAt <= now()) {
      throw new HostError(410, 'ERR_QUERY_EXPIRED', 'The query has expired')
    }
    if (request.contentHash !== record.attestation.contentHash) {
      throw new HostError(409, 'ERR_HASH_MISMATCH', 'This host attested a different content hash')
    }
    if (request.ranking.length > record.query.topK) {
      throw new HostError(400, 'ERR_INVALID_COLLECT', 'ranking is longer than the query topK')
    }
    const host = await hostKey()
    const rank = request.ranking.indexOf(host) + 1
    if (rank === 0) throw new HostError(409, 'ERR_NOT_RANKED', 'This host is not in the ranking')

    const share = computePayouts(floorFor(record.payload.length), request.ranking.length)[rank - 1]
    const required = Math.max(minPayoutSats, share)
    if (request.payment === undefined) throw paymentRequired(required)
    if (!(await store.beginSettle(request.queryId))) {
      throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
    }
    try {
      const payment = await verifyAndInternalizePayment({
        wallet,
        envelope: request.payment,
        queryId: request.queryId,
        rank,
        clientIdentityKey: client,
        requiredSats: required,
        originator
      })
      if (!payment.ok) {
        if (payment.reason === 'malformed') {
          throw new HostError(
            400,
            'ERR_INVALID_COLLECT',
            'Payment is not bound to this query and rank'
          )
        }
        throw paymentRequired(required)
      }
      const delivery = await signDelivery(
        wallet,
        { queryId: request.queryId, host, payload: record.payload, supplement: record.supplement },
        originator
      )
      await store.completeSettle(request.queryId)
      res.status(200).json(delivery)
    } catch (error) {
      await store.abortSettle(request.queryId)
      throw error
    }
  })

  return {
    params,
    query,
    collect,
    mount(router) {
      router.get(ECONOMIC_PATHS.params, params)
      router.post(ECONOMIC_PATHS.query, query)
      router.post(ECONOMIC_PATHS.collect, collect)
    }
  }
}
