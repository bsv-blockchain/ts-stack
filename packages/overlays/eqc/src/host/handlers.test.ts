import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import {
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery
} from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import { paymentEnvelope, payoutLockingScript, type PaymentEnvelope } from '../protocol/payment.js'
import { computeQueryId, type EconomicQuery } from '../protocol/query.js'
import {
  createEconomicQueryHost,
  type EconomicQueryHost,
  type EconomicQueryHostOptions,
  type HostRequest
} from './handlers.js'
import { InMemoryPendingStore } from './pendingStore.js'
import { bytesProvider } from './providers.js'

const NOW = Date.parse('2026-09-18T19:00:00.000Z')
const PAYLOAD = [1, 2, 3, 4]

interface Recorded {
  statusCode: number
  body: any
  headers: Record<string, string>
  status: (code: number) => Recorded
  json: (body: unknown) => Recorded
  set: (name: string, value: string) => Recorded
}

function recorder(): Recorded {
  const response: Recorded = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code) {
      response.statusCode = code
      return response
    },
    json(body) {
      response.body = body
      return response
    },
    set(name, value) {
      response.headers[name.toLowerCase()] = value
      return response
    }
  }
  return response
}

function request(identityKey: string | undefined, body?: unknown, headers = {}): HostRequest {
  return { body, headers, auth: identityKey === undefined ? undefined : { identityKey } }
}

function makeHost(overrides: Partial<EconomicQueryHostOptions> = {}): {
  host: EconomicQueryHost
  wallet: HostWallet
} {
  const wallet = new HostWallet()
  const host = createEconomicQueryHost({
    wallet,
    providers: [bytesProvider('relay-lookup', async () => PAYLOAD)],
    now: () => NOW,
    logger: { error: () => undefined },
    ...overrides
  })
  return { host, wallet }
}

function makeQuery(client: string, overrides: Partial<EconomicQuery> = {}): EconomicQuery {
  return {
    type: 'relay-lookup',
    client,
    params: { key: 'k' },
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: new Date(NOW + 30_000).toISOString(),
    nonce: '11'.repeat(32),
    ...overrides
  }
}

async function attest(host: EconomicQueryHost, query: EconomicQuery): Promise<Recorded> {
  const response = recorder()
  await host.query(request(query.client, query), response)
  return response
}

async function pay(
  payer: PayerWallet,
  queryId: string,
  ranking: string[],
  satoshis: number[],
  rank: number
): Promise<PaymentEnvelope> {
  const outputs = await Promise.all(
    ranking.map(async (hostKey, index) => ({
      lockingScript: await payoutLockingScript(payer, hostKey, queryId, index + 1, false),
      satoshis: satoshis[index],
      outputDescription: `Rank ${index + 1} payout`
    }))
  )
  const action = await payer.createAction({ description: 'BRC-178 query payout', outputs })
  if (action.tx === undefined) throw new Error('No transaction')
  return paymentEnvelope(queryId, rank, Array.from(action.tx))
}

describe('params', () => {
  it('advertises the market without authentication', async () => {
    const { host, wallet } = makeHost()
    const response = recorder()
    await host.params(request(undefined), response)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      version: 1,
      host: wallet.identityKey,
      threshold: 3,
      topK: 5,
      floorFeeSats: 1000,
      minPayoutSats: 1,
      maxQueryTtlMs: 60_000,
      classes: ['relay-lookup']
    })
  })

  it('mounts the three economic routes', () => {
    const { host } = makeHost()
    const routes: string[] = []
    host.mount({
      get: path => routes.push(`GET ${path}`),
      post: path => routes.push(`POST ${path}`)
    })
    expect(routes).toEqual([
      'GET /economic/params',
      'POST /economic/query',
      'POST /economic/collect'
    ])
  })
})

describe('query', () => {
  it('requires BRC-103 authentication', async () => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    for (const identity of [undefined, 'unknown']) {
      const response = recorder()
      await host.query(request(identity, makeQuery(payer.identityKey)), response)
      expect(response.statusCode).toBe(401)
      expect(response.body.code).toBe('ERR_AUTH_REQUIRED')
    }
  })

  it('returns a verifiable attestation quoting the floor', async () => {
    const { host, wallet } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const response = await attest(host, query)
    expect(response.statusCode).toBe(200)
    const attestation = parseAttestation(response.body)
    expect(attestation.payloadSize).toBe(PAYLOAD.length)
    expect(attestation.quotedFeeSats).toBe(1000)
    expect(
      verifyAttestation(attestation, { queryId: computeQueryId(query), host: wallet.identityKey })
    ).toBe('ok')
  })

  it('repeats a pending attestation and rejects a client-supplied queryId field', async () => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const first = await attest(host, query)
    const second = await attest(host, query)
    expect(second.body.signature).toBe(first.body.signature)
    const withId = recorder()
    await host.query(request(payer.identityKey, { ...query, queryId: 'ff'.repeat(32) }), withId)
    expect(withId.statusCode).toBe(400)
  })

  it.each([
    ['an invalid body', (q: EconomicQuery) => ({ ...q, threshold: 0 }), 400, 'ERR_INVALID_QUERY'],
    [
      'another client',
      (q: EconomicQuery) => ({ ...q, client: `03${'cd'.repeat(32)}` }),
      400,
      'ERR_INVALID_QUERY'
    ],
    [
      'a distant expiry',
      (q: EconomicQuery) => ({ ...q, expires: new Date(NOW + 120_000).toISOString() }),
      400,
      'ERR_INVALID_QUERY'
    ],
    [
      'a past expiry',
      (q: EconomicQuery) => ({ ...q, expires: new Date(NOW - 1).toISOString() }),
      410,
      'ERR_QUERY_EXPIRED'
    ],
    [
      'an unknown class',
      (q: EconomicQuery) => ({ ...q, type: 'message-body' }),
      422,
      'ERR_UNSUPPORTED_CLASS'
    ],
    [
      'a strict host set without this host',
      (q: EconomicQuery) => ({ ...q, strictHosts: true, hostSetHint: [`03${'ef'.repeat(32)}`] }),
      400,
      'ERR_INVALID_QUERY'
    ]
  ])('rejects %s', async (_label, mutate, status, code) => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    const response = recorder()
    await host.query(request(payer.identityKey, mutate(makeQuery(payer.identityKey))), response)
    expect(response.statusCode).toBe(status)
    expect(response.body).toMatchObject({ status: 'error', code })
  })

  it('answers 402 when the client budget is below the host floor', async () => {
    const { host } = makeHost({ floorFeeSats: size => 5000 + size })
    const payer = new PayerWallet()
    const response = await attest(host, makeQuery(payer.identityKey))
    expect(response.statusCode).toBe(402)
    expect(response.headers['x-bsv-payment-satoshis-required']).toBe('5004')
    expect(response.headers['x-bsv-payment-version']).toBe('1.0')
  })

  it('bounds payload size and pending queries', async () => {
    const payer = new PayerWallet()
    const small = makeHost({ maxPayloadBytes: 3 })
    expect((await attest(small.host, makeQuery(payer.identityKey))).statusCode).toBe(413)

    const capped = makeHost({
      store: new InMemoryPendingStore({ maxPendingPerClient: 1 }, () => NOW)
    })
    expect((await attest(capped.host, makeQuery(payer.identityKey))).statusCode).toBe(200)
    const second = await attest(
      capped.host,
      makeQuery(payer.identityKey, { nonce: '22'.repeat(32) })
    )
    expect(second.statusCode).toBe(429)
    expect(second.body.code).toBe('ERR_TOO_MANY_PENDING')
  })

  it('answers two concurrent identical queries from a single stored record', async () => {
    // The cap of one proves the second query stored nothing: a second record would answer 429.
    const store = new InMemoryPendingStore({ maxPendingPerClient: 1 }, () => NOW)
    const { host } = makeHost({ store })
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const [first, second] = await Promise.all([attest(host, query), attest(host, query)])
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(second.body.signature).toBe(first.body.signature)
    const stored = await store.get(computeQueryId(query))
    expect(stored?.state).toBe('pending')
    expect(stored?.attestation.signature).toBe(first.body.signature)
  })

  it('passes provider HostErrors through and hides every other failure', async () => {
    const payer = new PayerWallet()
    const forbidden = makeHost({
      providers: [
        bytesProvider('relay-lookup', async () => {
          throw new HostError(403, 'ERR_FORBIDDEN_RECIPIENT', 'Not yours')
        })
      ]
    })
    expect((await attest(forbidden.host, makeQuery(payer.identityKey))).statusCode).toBe(403)

    const broken = makeHost({
      providers: [
        bytesProvider('relay-lookup', async () => {
          throw new Error('database password is hunter2')
        })
      ]
    })
    const response = await attest(broken.host, makeQuery(payer.identityKey))
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'Internal error'
    })
  })
})

describe('collect', () => {
  async function prepared(): Promise<{
    host: EconomicQueryHost
    wallet: HostWallet
    payer: PayerWallet
    query: EconomicQuery
    queryId: string
    contentHash: string
    ranking: string[]
  }> {
    const { host, wallet } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const attestation = parseAttestation((await attest(host, query)).body)
    const ranking = [new HostWallet().identityKey, wallet.identityKey, new HostWallet().identityKey]
    return {
      host,
      wallet,
      payer,
      query,
      queryId: attestation.queryId,
      contentHash: attestation.contentHash,
      ranking
    }
  }

  it('delivers the attested bytes once its rank is paid', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const body = { type: 'collect', queryId, contentHash, ranking, payment }
    const response = recorder()
    await host.collect(request(payer.identityKey, body), response)
    expect(response.statusCode).toBe(200)
    const verdict = verifyDelivery(parseDelivery(response.body), {
      queryId,
      host: wallet.identityKey,
      contentHash
    })
    expect(verdict).toEqual({ verdict: 'ok', payload: PAYLOAD, supplement: [] })
    expect(wallet.internalized).toEqual([
      expect.objectContaining({ outputIndex: 1, satoshis: 250 })
    ])

    const replay = recorder()
    await host.collect(request(payer.identityKey, body), replay)
    expect(replay.statusCode).toBe(409)
    expect(replay.body.code).toBe('ERR_QUERY_SETTLED')
  })

  it('refuses a settled query on the query route too', async () => {
    const { host, payer, query, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking, payment }),
      recorder()
    )
    expect((await attest(host, query)).statusCode).toBe(409)
  })

  it('accepts the payment in the x-bsv-payment header', async () => {
    const { host, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const response = recorder()
    await host.collect(
      request(
        payer.identityKey,
        { type: 'collect', queryId, contentHash, ranking },
        { 'x-bsv-payment': JSON.stringify(payment) }
      ),
      response
    )
    expect(response.statusCode).toBe(200)
  })

  it('demands its Fibonacci share and lets the client retry', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const missing = recorder()
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking }),
      missing
    )
    expect(missing.statusCode).toBe(402)
    expect(missing.headers['x-bsv-payment-satoshis-required']).toBe('250')

    const cheap = await pay(payer, queryId, ranking, [500, 100, 250], 2)
    const underpaid = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId,
        contentHash,
        ranking,
        payment: cheap
      }),
      underpaid
    )
    expect(underpaid.statusCode).toBe(402)
    expect(wallet.internalized).toEqual([])

    const fair = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const retried = recorder()
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking, payment: fair }),
      retried
    )
    expect(retried.statusCode).toBe(200)
  })

  it('rejects bad collects with the documented codes', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const base = { type: 'collect', queryId, contentHash, ranking, payment }
    const cases: Array<[string | undefined, unknown, number, string]> = [
      [undefined, base, 401, 'ERR_AUTH_REQUIRED'],
      [payer.identityKey, { ...base, type: 'other' }, 400, 'ERR_INVALID_COLLECT'],
      [
        payer.identityKey,
        { ...base, ranking: [wallet.identityKey, wallet.identityKey] },
        400,
        'ERR_INVALID_COLLECT'
      ],
      [payer.identityKey, { ...base, queryId: 'ff'.repeat(32) }, 404, 'ERR_QUERY_UNKNOWN'],
      [new PayerWallet().identityKey, base, 404, 'ERR_QUERY_UNKNOWN'],
      [payer.identityKey, { ...base, contentHash: 'ee'.repeat(32) }, 409, 'ERR_HASH_MISMATCH'],
      [payer.identityKey, { ...base, ranking: [ranking[0]] }, 409, 'ERR_NOT_RANKED'],
      [
        payer.identityKey,
        { ...base, payment: paymentEnvelope(queryId, 3, [1, 2, 3]) },
        400,
        'ERR_INVALID_COLLECT'
      ]
    ]
    for (const [identity, body, status, code] of cases) {
      const response = recorder()
      await host.collect(request(identity, body), response)
      expect([response.statusCode, response.body.code]).toEqual([status, code])
    }
    expect(wallet.internalized).toEqual([])
  })

  it('rejects a ranking longer than topK and an expired query', async () => {
    const payer = new PayerWallet()
    let now = NOW
    const { host, wallet } = makeHost({ now: () => now })
    const query = makeQuery(payer.identityKey, { threshold: 1, topK: 1 })
    const attestation = parseAttestation((await attest(host, query)).body)
    const ranking = [wallet.identityKey, new HostWallet().identityKey]
    const tooLong = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId: attestation.queryId,
        contentHash: attestation.contentHash,
        ranking
      }),
      tooLong
    )
    expect([tooLong.statusCode, tooLong.body.code]).toEqual([400, 'ERR_INVALID_COLLECT'])

    now = NOW + 31_000
    const expired = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId: attestation.queryId,
        contentHash: attestation.contentHash,
        ranking: [wallet.identityKey]
      }),
      expired
    )
    expect([expired.statusCode, expired.body.code]).toEqual([410, 'ERR_QUERY_EXPIRED'])
  })

  it('delivers exactly once under concurrent collects', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const body = { type: 'collect', queryId, contentHash, ranking, payment }
    const responses = [recorder(), recorder(), recorder()]
    await Promise.all(
      responses.map(async r => await host.collect(request(payer.identityKey, body), r))
    )
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409, 409])
    expect(wallet.internalized).toHaveLength(1)
  })
})
