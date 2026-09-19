import { Transaction, Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { LoopbackNetwork, type LoopbackHost } from '../../test/support/loopback.js'
import { sampleBeef, slapTokenOutput } from '../../test/support/transactions.js'
import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { bytesProvider, messageListProvider, overlayLookupProvider } from '../host/providers.js'
import { rebuildLookupAnswer } from '../protocol/payloads.js'
import { EQCError } from '../protocol/errors.js'
import { computePayouts } from '../protocol/fibonacci.js'
import { DEFAULTS } from '../protocol/query.js'
import type { LookupResolverLike } from './discovery.js'
import { EQC, type EQCOptions } from './EQC.js'
import { InMemoryReputationStore } from './reputation.js'
import { TransportStatusError } from './transport.js'

const ANSWER = [1, 2, 3, 4]
const urls = [1, 2, 3, 4, 5].map(n => `https://h${n}.example`)

function relay(payload: number[]): ReturnType<typeof bytesProvider> {
  return bytesProvider('relay-lookup', async () => payload)
}

function setup(options: EQCOptions = {}): {
  payer: PayerWallet
  network: LoopbackNetwork
  eqc: EQC
} {
  const payer = new PayerWallet()
  const network = new LoopbackNetwork(payer.identityKey)
  const eqc = new EQC(payer, {
    transport: network,
    hostOverrides: { 'relay-lookup': urls, ls_x: urls, 'message-list': urls },
    // Real timers: every gap an assertion depends on is at least 25 ms, and the race window is
    // wide enough that all five honest hosts land inside it even on a loaded runner.
    raceMs: 200,
    hostTimeoutMs: 1500,
    ...options
  })
  return { payer, network, eqc }
}

async function failure(promise: Promise<unknown>): Promise<EQCError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EQCError) return error
    throw error
  }
  throw new Error('Expected an EQCError')
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

const request = { type: 'relay-lookup', params: { key: 'k' } }

describe('EQC.query', () => {
  it('pays the five fastest agreeing hosts by arrival order from one transaction', async () => {
    const { payer, network, eqc } = setup()
    const hosts = urls.map((url, index) =>
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: (5 - index) * 25 })
    )
    const result = await eqc.query(request)
    await result.completion

    expect(result.payload).toEqual(ANSWER)
    expect(result.feeSats).toBe(1000)
    expect(result.ranking.map(entry => entry.url)).toEqual([...urls].reverse())
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([418, 250, 166, 83, 83])
    expect(result.ranking[0].arrivalMs).toBe(0)
    expect(result.rejected).toEqual([])
    expect(result.attestations).toHaveLength(5)

    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].outputs).toHaveLength(5)
    const fastest = hosts[4].wallet.internalized
    expect(fastest).toEqual([expect.objectContaining({ txid: result.txid, satoshis: 418 })])
    expect(hosts[0].wallet.internalized).toEqual([expect.objectContaining({ satoshis: 83 })])
  })

  it('leaves a host that answers differently unpaid', async () => {
    const { network, eqc } = setup()
    const stale = network.add(urls[0], { providers: [relay([9, 9])] })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.ranking).toHaveLength(4)
    expect(result.ranking.map(entry => entry.payoutSats).reduce((a, b) => a + b, 0)).toBe(1000)
    expect(result.rejected).toEqual([
      {
        url: urls[0],
        host: stale.wallet.identityKey,
        reason: 'minority-hash',
        detail: 'minority-hash'
      }
    ])
    expect(stale.wallet.internalized).toEqual([])
    expect(stale.posts.map(post => post.path)).toEqual(['/economic/query'])
  })

  it('refuses to start with fewer market hosts than the threshold', async () => {
    const { payer, network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)] })
    network.add(urls[1], { providers: [relay(ANSWER)] })
    for (const url of urls.slice(2)) {
      network.add(url, { providers: [relay(ANSWER)] }, { down: true })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_NO_HOSTS')
    expect(payer.actions).toEqual([])
  })

  it('pays nobody and touches no wallet when the threshold is not met', async () => {
    const { payer, network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)] })
    network.add(urls[1], { providers: [relay([])] })
    network.add(urls[2], { providers: [relay([])] })
    network.add(urls[3], { providers: [relay([7])] })
    network.add(urls[4], { providers: [relay([8])] })
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_THRESHOLD')
    expect((error.details.groups as unknown[]).length).toBe(4)
    expect(payer.actions).toEqual([])
    for (const host of network.hosts.values()) {
      expect(host.posts.map(post => post.path)).toEqual(['/economic/query'])
    }
  })

  it('makes hoarding self-defeating: the lone holder is the minority', async () => {
    const { network, eqc } = setup()
    const hoarder = network.add(urls[0], { providers: [relay(ANSWER)] })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay([])] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.payload).toEqual([])
    expect(hoarder.wallet.internalized).toEqual([])
    expect(result.ranking).toHaveLength(4)
  })

  it('survives a liar, gets the bytes elsewhere, and cools the liar down', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const liar = network.add(urls[0], { providers: [relay(ANSWER)] })
    liar.tamperDelivery = body => ({ ...body, payload: Utils.toBase64([6, 6, 6, 6]) })
    for (const url of urls.slice(1)) {
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 30 })
    }
    const result = await eqc.query(request)
    await result.completion
    expect(result.payload).toEqual(ANSWER)
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'hash-mismatch' })
    )
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(true)

    const again = await eqc.query(request)
    await again.completion
    expect(again.ranking.map(entry => entry.url)).not.toContain(urls[0])
  })

  it('discards and cools down a host whose session key differs from the key it signs with', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const spoof = network.add(urls[0], { providers: [relay(ANSWER)] })
    spoof.sessionIdentity = new HostWallet().identityKey
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'identity-mismatch' })
    )
    expect(spoof.wallet.internalized).toEqual([])
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(true)
  })

  it('counts a slow host as late and does not pay it', async () => {
    const { network, eqc } = setup({ raceMs: 100 })
    for (const url of urls.slice(0, 3)) network.add(url, { providers: [relay(ANSWER)] })
    const slow = network.add(urls[3], { providers: [relay(ANSWER)] }, { delayMs: 500 })
    network.add(urls[4], { providers: [relay(ANSWER)] }, { withoutMarket: true })
    const result = await eqc.query(request)
    await result.completion
    expect(result.ranking).toHaveLength(3)
    expect(result.rejected).toContainEqual({ url: urls[3], reason: 'late' })
    expect(slow.wallet.internalized).toEqual([])
  })

  it('respects the budget: a greedy host is skipped, an impossible floor is refused', async () => {
    const { network, eqc } = setup()
    const greedy = network.add(urls[0], { providers: [relay(ANSWER)], floorFeeSats: 5000 })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.feeSats).toBe(1000)
    expect(greedy.posts).toEqual([])

    const error = await failure(eqc.query(request, { floorFeeSats: 3000 }))
    expect(error.code).toBe('ERR_EQC_BUDGET')
  })

  it('raises the fee to the highest advertised floor within budget', async () => {
    const { network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)], floorFeeSats: 1500 })
    for (const url of urls.slice(1, 3)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.feeSats).toBe(1500)
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([750, 375, 375])
  })

  it('reports a wallet that cannot pay before any collect is sent', async () => {
    const { payer, network, eqc } = setup()
    const hosts = urls.map(url => network.add(url, { providers: [relay(ANSWER)] }))
    payer.failCreateAction = true
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_PAYMENT')
    expect(hosts.flatMap(host => host.posts.map(post => post.path))).not.toContain(
      '/economic/collect'
    )
  })

  it('reports an undelivered query with the payout txid', async () => {
    const { network, eqc } = setup()
    for (const url of urls) {
      network.add(url, { providers: [relay(ANSWER)] }).tamperDelivery = body => ({
        ...body,
        payload: Utils.toBase64([0])
      })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_UNDELIVERED')
    expect(error.details.txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails with no attestation when every host errors', async () => {
    const { network, eqc } = setup()
    for (const url of urls) {
      network.add(url, {
        providers: [
          bytesProvider('relay-lookup', async () => {
            throw new Error('storage offline')
          })
        ]
      })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_NO_ATTESTATION')
  })

  it('validates its configuration', () => {
    const payer = new PayerWallet()
    expect(() => new EQC(payer, { threshold: 3, topK: 2 })).toThrow(RangeError)
    expect(() => new EQC(payer, { threshold: 1, topK: 1 })).not.toThrow()
    expect(() => new EQC(payer, { raceMs: -1 })).toThrow(RangeError)
  })
})

describe('EQC.params', () => {
  it('retries a host whose params read failed transiently once the short negative cache lapses', async () => {
    let now = Date.now()
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ now: () => now, reputation })
    const flaky = network.add(
      urls[0],
      { providers: [relay(ANSWER)] },
      { transientParamsFailures: 1 }
    )
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })

    const first = await eqc.query(request)
    await first.completion
    expect(first.ranking.map(entry => entry.url)).not.toContain(urls[0])
    expect(first.rejected).toContainEqual(expect.objectContaining({ url: urls[0], reason: 'http' }))
    expect(reputation.score(urls[0])).toBe(-1)
    expect(reputation.isExcluded(urls[0], now)).toBe(false)

    // Inside the short interval the failure is remembered: no probe, and no second penalty.
    now += 14_999
    const second = await eqc.query(request)
    await second.completion
    expect(second.ranking.map(entry => entry.url)).not.toContain(urls[0])
    expect(flaky.paramsReads).toBe(1)
    expect(reputation.score(urls[0])).toBe(-1)

    now += 1
    const again = await eqc.query(request)
    await again.completion
    expect(again.ranking.map(entry => entry.url)).toContain(urls[0])
    expect(again.rejected).toEqual([])
    expect(flaky.paramsReads).toBe(2)
  })

  it('bounds the negative cache of a passing failure by paramsTtlMs when that is shorter', async () => {
    let now = Date.now()
    const { network, eqc } = setup({ now: () => now, paramsTtlMs: 5000 })
    const flaky = network.add(
      urls[0],
      { providers: [relay(ANSWER)] },
      { transientParamsFailures: 1 }
    )
    await expect(eqc.params(urls[0])).rejects.toThrow('dropped the params connection')
    now += 4999
    await expect(eqc.params(urls[0])).rejects.toThrow('dropped the params connection')
    expect(flaky.paramsReads).toBe(1)
    now += 1
    expect((await eqc.params(urls[0])).host).toBe(flaky.wallet.identityKey)
    expect(flaky.paramsReads).toBe(2)
  })

  it('waits on a tarpit once per interval, not once per query', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ paramsTimeoutMs: 600, hostTimeoutMs: 5000, reputation })
    const tarpit = network.add(urls[0], { providers: [relay(ANSWER)] }, { paramsHang: true })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })

    const startedFirst = performance.now()
    const first = await eqc.query(request)
    const firstMs = performance.now() - startedFirst
    await first.completion
    expect(tarpit.paramsTimeouts).toEqual([600])
    expect(firstMs).toBeGreaterThanOrEqual(590)
    expect(firstMs).toBeLessThan(5000)
    expect(first.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'timeout' })
    )
    expect(reputation.score(urls[0])).toBe(-1)
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(false)

    const startedSecond = performance.now()
    const second = await eqc.query(request)
    const secondMs = performance.now() - startedSecond
    await second.completion
    expect(second.ranking).toHaveLength(4)
    expect(tarpit.paramsReads).toBe(1)
    expect(secondMs).toBeLessThan(600)
  })

  it('probes params under paramsTimeoutMs, 2000 ms by default, not under hostTimeoutMs', async () => {
    const { network, eqc } = setup()
    const host = network.add(urls[0], { providers: [relay(ANSWER)] })
    await eqc.params(urls[0])
    expect(host.paramsTimeouts).toEqual([2000])
    expect(DEFAULTS.paramsTimeoutMs).toBe(2000)
  })

  it('probes a host with no market once across two queries inside the params TTL', async () => {
    const { network, eqc } = setup()
    for (const url of urls.slice(0, 4)) network.add(url, { providers: [relay(ANSWER)] })
    const marketless = network.add(urls[4], { providers: [relay(ANSWER)] }, { withoutMarket: true })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await eqc.query(request)
      await result.completion
      expect(result.ranking).toHaveLength(4)
    }
    expect(marketless.paramsReads).toBe(1)
  })

  it('surfaces the transport status error for a 404 host, cached and uncached alike', async () => {
    const { network, eqc } = setup()
    const marketless = network.add(urls[0], { providers: [relay(ANSWER)] }, { withoutMarket: true })

    const thrown = await rejection(eqc.params(urls[0]))
    expect(thrown).toBeInstanceOf(TransportStatusError)
    expect((thrown as TransportStatusError).status).toBe(404)
    expect(await rejection(eqc.params(urls[0]))).toBe(thrown)
    expect(marketless.paramsReads).toBe(1)
  })
})

describe('EQC reputation and host selection', () => {
  it('cools down a host that takes its payout and fails the collect', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const taker = network.add(urls[0], { providers: [relay(ANSWER)] })
    // The wallet throws, so the host answers 500 after the payout was already broadcast.
    taker.wallet.internalizeError = new Error('Must add active storage provider to wallet.')
    for (const url of urls.slice(1)) {
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 30 })
    }
    const result = await eqc.query(request)
    await result.completion
    expect(result.payload).toEqual(ANSWER)
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'collect-failed', detail: 'status 500' })
    )
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(true)

    const again = await eqc.query(request)
    await again.completion
    expect(taker.posts.filter(post => post.path === '/economic/query')).toHaveLength(1)
    expect(again.ranking.map(entry => entry.url)).not.toContain(urls[0])
  })

  it('does not exclude a minority host on the word of the winners anchors', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const anchored = (payloadTxSats: number): ReturnType<typeof overlayLookupProvider> =>
      overlayLookupProvider({
        engine: {
          lookup: async () => ({
            type: 'output-list',
            outputs: [{ beef: sampleBeef(payloadTxSats).beef, outputIndex: 0 }]
          }),
          provideTopicAnchorTip: async topic => ({ topic, blockHeight: 900, tac: 'cd'.repeat(32) })
        },
        anchorTopics: { ls_x: ['tm_x'] }
      })
    const honest = network.add(urls[0], { providers: [anchored(1)] })
    for (const url of urls.slice(1)) network.add(url, { providers: [anchored(2)] })
    const lookup = { type: 'overlay-lookup', params: { service: 'ls_x', query: {} } }
    const result = await eqc.query(lookup)
    await result.completion
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'minority-hash', detail: 'diverged-answer' })
    )
    expect(reputation.score(urls[0])).toBe(-1)
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(false)

    const again = await eqc.query(lookup)
    await again.completion
    expect(honest.posts.filter(post => post.path === '/economic/query')).toHaveLength(2)
  })

  it('always contacts higher-scored hosts first when maxHosts cuts the list', async () => {
    const reputation = new InMemoryReputationStore()
    reputation.record(urls[3], 'success', 0)
    reputation.record(urls[4], 'success', 0)
    const { network, eqc } = setup({ reputation, maxHosts: 2, threshold: 2, topK: 2 })
    const hosts = urls.map(url => network.add(url, { providers: [relay(ANSWER)] }))
    for (let run = 0; run < 5; run++) {
      const result = await eqc.query(request)
      await result.completion
      expect(result.ranking.map(entry => entry.url).sort()).toEqual([urls[3], urls[4]])
    }
    for (const host of hosts.slice(0, 3)) expect(host.posts).toEqual([])
  })

  it('breaks reputation ties at random, so discovery order does not pick the hosts', async () => {
    const contacted = new Set<string>()
    for (let run = 0; run < 40 && contacted.size < 2; run++) {
      // A fresh client and market each time, so an earlier success never breaks the tie.
      const { network, eqc } = setup({ maxHosts: 1, threshold: 1, topK: 1 })
      for (const url of urls) network.add(url, { providers: [relay(ANSWER)] })
      const result = await eqc.query(request)
      await result.completion
      expect(result.ranking).toHaveLength(1)
      contacted.add(result.ranking[0].url)
    }
    // Always the first discovered host would mean 40 identical draws out of five hosts.
    expect(contacted.size).toBeGreaterThan(1)
  })
})

describe('EQC host market limits', () => {
  it('skips a host whose advertised topK is below the topK the client wants', async () => {
    const { network, eqc } = setup()
    const narrow = network.add(urls[0], { providers: [relay(ANSWER)], topK: 3 })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(narrow.posts).toEqual([])
    expect(result.ranking).toHaveLength(4)
    expect(result.rejected).toEqual([])

    const three = await eqc.query(request, { topK: 3 })
    await three.completion
    expect(narrow.posts.map(post => post.path)).toContain('/economic/query')
  })

  it('sends no output and no collect to a ranked host whose share is below its minPayoutSats', async () => {
    const reputation = new InMemoryReputationStore()
    const { payer, network, eqc } = setup({ reputation })
    // Slowest of five, so it ranks fifth: its share of 1000 is 83, below the 100 it demands.
    const picky = network.add(
      urls[0],
      { providers: [relay(ANSWER)], minPayoutSats: 100 },
      { delayMs: 120 }
    )
    const others = urls
      .slice(1)
      .map((url, index) =>
        network.add(url, { providers: [relay(ANSWER)] }, { delayMs: index * 25 })
      )
    const result = await eqc.query(request)
    await result.completion

    expect(result.ranking.map(entry => entry.url)).toEqual([...urls.slice(1), urls[0]])
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([418, 250, 166, 83, 0])
    expect(result.feeSats).toBe(917)
    expect(payer.actions[0].outputs?.map(output => output.satoshis)).toEqual([418, 250, 166, 83])
    expect(picky.posts.map(post => post.path)).toEqual(['/economic/query'])
    expect(result.rejected).toEqual([
      {
        url: urls[0],
        host: picky.wallet.identityKey,
        reason: 'collect-failed',
        detail: 'share below host minPayoutSats'
      }
    ])
    // It did nothing wrong: no reputation event at all.
    expect(reputation.score(urls[0])).toBe(0)
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(false)

    // The other hosts still see the full ranking, so their ranks and shares are unchanged.
    const collects = others[3].posts.filter(post => post.path === '/economic/collect')
    expect(collects.map(post => (post.body as { ranking: string[] }).ranking)).toEqual([
      result.ranking.map(entry => entry.host)
    ])
    expect(others[3].wallet.internalized).toEqual([expect.objectContaining({ satoshis: 83 })])
  })

  it('serves the fastest host when another host floor sits one satoshi higher', async () => {
    // Floors 1007 and 1008 make the client pay 1008, whose rank 1 payout (420) is below the
    // rank 1 payout at 1007 (423). The fastest host must still be served.
    const { network, eqc } = setup()
    const fastest = network.add(urls[0], { providers: [relay(ANSWER)], floorFeeSats: 1007 })
    network.add(urls[1], { providers: [relay(ANSWER)], floorFeeSats: 1008 }, { delayMs: 25 })
    for (const [index, url] of urls.slice(2).entries()) {
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 50 + index * 25 })
    }
    const result = await eqc.query(request)
    await result.completion
    expect(result.feeSats).toBe(1008)
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual(computePayouts(1008, 5))
    expect(result.rejected).toEqual([])
    expect(fastest.wallet.internalized).toEqual([expect.objectContaining({ satoshis: 420 })])
  })
})

describe('EQC advertised identity keys', () => {
  const SERVICE = 'ls_y'
  const lookup = { type: 'overlay-lookup', params: { service: SERVICE, query: {} } }

  function lookupProvider(): ReturnType<typeof overlayLookupProvider> {
    return overlayLookupProvider({
      engine: {
        lookup: async () => ({
          type: 'output-list',
          outputs: [{ beef: sampleBeef(1).beef, outputIndex: 0 }]
        })
      }
    })
  }

  function resolverOf(tokens: Array<{ url: string; advertiser: HostWallet }>): LookupResolverLike {
    return {
      query: async () => ({
        type: 'output-list',
        outputs: await Promise.all(
          tokens.map(async token => await slapTokenOutput(token.advertiser, token.url, SERVICE))
        )
      })
    }
  }

  function market(
    tokensFor: (hosts: LoopbackHost[]) => Array<{ url: string; advertiser: HostWallet }>
  ): {
    network: LoopbackNetwork
    hosts: LoopbackHost[]
    eqc: EQC
    reputation: InMemoryReputationStore
  } {
    const payer = new PayerWallet()
    const network = new LoopbackNetwork(payer.identityKey)
    const hosts = urls.slice(0, 3).map(url => network.add(url, { providers: [lookupProvider()] }))
    const reputation = new InMemoryReputationStore()
    const eqc = new EQC(payer, {
      transport: network,
      resolver: resolverOf(tokensFor(hosts)),
      reputation,
      raceMs: 200,
      hostTimeoutMs: 1500
    })
    return { network, hosts, eqc, reputation }
  }

  it.each(['before', 'after'] as const)(
    'keeps an honest host whose URL a third party also advertised %s it',
    async position => {
      const squatter = new HostWallet()
      const { hosts, eqc, reputation } = market(all => {
        const honest = all.map(host => ({ url: host.url, advertiser: host.wallet }))
        const hostile = { url: urls[0], advertiser: squatter }
        return position === 'before' ? [hostile, ...honest] : [...honest, hostile]
      })
      const result = await eqc.query(lookup)
      await result.completion
      expect(result.rejected).toEqual([])
      expect(result.ranking.map(entry => entry.url).sort()).toEqual(urls.slice(0, 3))
      expect(reputation.isExcluded(urls[0], Date.now())).toBe(false)
      const sent = hosts[0].posts[0].body as { hostSetHint: string[] }
      expect(sent.hostSetHint).toEqual(
        [squatter.identityKey, ...hosts.map(host => host.wallet.identityKey)].sort()
      )
    }
  )

  it('rejects a host no advertisement names, without cooling down the URL', async () => {
    const { eqc, reputation } = market(all => [
      { url: urls[0], advertiser: new HostWallet() },
      ...all.slice(1).map(host => ({ url: host.url, advertiser: host.wallet }))
    ])
    const result = await eqc.query(lookup, { threshold: 2 })
    await result.completion
    expect(result.ranking.map(entry => entry.url).sort()).toEqual(urls.slice(1, 3))
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'identity-mismatch' })
    )
    // The advertisement is third-party data, so this is a soft event.
    expect(reputation.score(urls[0])).toBe(-1)
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(false)
  })
})

describe('EQC supplement validation and deadlines', () => {
  it('rejects a delivery whose supplement lacks a listed transaction and takes the bytes elsewhere', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const hosts = urls.map((url, index) =>
      network.add(
        url,
        {
          providers: [
            overlayLookupProvider({
              engine: {
                lookup: async () => ({
                  type: 'output-list',
                  outputs: [
                    { beef: first.beef, outputIndex: 0 },
                    { beef: second.beef, outputIndex: 0 }
                  ]
                })
              }
            })
          ]
        },
        { delayMs: index === 0 ? 0 : 40 }
      )
    )
    // The payload still hashes to the attested value; only the unauthenticated supplement is
    // swapped for a BEEF that holds neither listed transaction.
    hosts[0].tamperDelivery = body => ({ ...body, supplement: Utils.toBase64(sampleBeef(9).beef) })

    const rebuilt = await eqc.lookup({ service: 'ls_x', query: { key: 'value' } })
    expect(
      rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex')).sort()
    ).toEqual([first.txid, second.txid].sort())

    // `lookup` does not expose the rejections, so the reputation store is the witness.
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(true)
    expect(reputation.score(urls[0])).toBe(-10)
    for (const url of urls.slice(1)) expect(reputation.isExcluded(url, Date.now())).toBe(false)
  })

  it('records the tampered supplement as collect-failed on the query result', async () => {
    const { network, eqc } = setup()
    const hosts = urls.map((url, index) =>
      network.add(
        url,
        {
          providers: [
            overlayLookupProvider({
              engine: {
                lookup: async () => ({
                  type: 'output-list',
                  outputs: [{ beef: sampleBeef(1).beef, outputIndex: 0 }]
                })
              }
            })
          ]
        },
        { delayMs: index === 0 ? 0 : 40 }
      )
    )
    hosts[0].tamperDelivery = body => ({ ...body, supplement: Utils.toBase64(sampleBeef(9).beef) })
    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: 'ls_x', query: {} }
    })
    await result.completion
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.rejected).toEqual([
      expect.objectContaining({ url: urls[0], reason: 'collect-failed' })
    ])
    expect(() => rebuildLookupAnswer(result.payload, result.supplement)).not.toThrow()
  })

  it('gives up on a host that never answers the query, at the per-host deadline', async () => {
    const { network, eqc } = setup({ hostTimeoutMs: 300, threshold: 1, topK: 1 })
    for (const url of urls.slice(0, 2)) {
      network.add(url, { providers: [relay(ANSWER)] }, { hangOn: '/economic/query' })
    }
    const started = performance.now()
    const error = await failure(eqc.query(request))
    expect(performance.now() - started).toBeLessThan(1500)
    expect(error.code).toBe('ERR_EQC_NO_ATTESTATION')
    // The detail is the transport's own timeout, so the deadline on `post` fired, not the race's.
    const rejected = error.details.rejected as Array<{ url: string; reason: string }>
    // The three URLs with no host behind them were dropped earlier, for having no market. Hosts
    // of equal reputation are contacted in random order, so the two are compared by URL.
    const stalled = rejected
      .filter(entry => urls.slice(0, 2).includes(entry.url))
      .sort((left, right) => left.url.localeCompare(right.url))
    expect(stalled).toEqual(
      urls.slice(0, 2).map(url => ({
        url,
        reason: 'timeout',
        detail: `${url} did not answer within 300 ms`
      }))
    )
  })

  it('gives up on a paid host that never answers the collect, and still completes', async () => {
    const { network, eqc } = setup({ hostTimeoutMs: 300 })
    const silent = network.add(
      urls[0],
      { providers: [relay(ANSWER)] },
      { hangOn: '/economic/collect' }
    )
    for (const url of urls.slice(1)) {
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 30 })
    }
    const started = performance.now()
    const result = await eqc.query(request)
    await result.completion
    expect(performance.now() - started).toBeLessThan(1500)
    expect(result.payload).toEqual(ANSWER)
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.rejected).toEqual([
      {
        url: urls[0],
        host: silent.wallet.identityKey,
        reason: 'collect-failed',
        detail: `${urls[0]} did not answer within 300 ms`
      }
    ])
  })

  it('reports an undelivered query when every paid host stalls, instead of hanging', async () => {
    const { network, eqc } = setup({ hostTimeoutMs: 300 })
    for (const url of urls) {
      network.add(url, { providers: [relay(ANSWER)] }, { hangOn: '/economic/collect' })
    }
    const started = performance.now()
    const error = await failure(eqc.query(request))
    expect(performance.now() - started).toBeLessThan(1500)
    expect(error.code).toBe('ERR_EQC_UNDELIVERED')
  })
})

describe('EQC convenience methods', () => {
  it('lookup rebuilds a LookupAnswer and reports BRC-136 consistency', async () => {
    const { network, eqc } = setup()
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const answer: LookupAnswer = {
      type: 'output-list',
      outputs: [
        { beef: first.beef, outputIndex: 0 },
        { beef: second.beef, outputIndex: 0 }
      ]
    }
    for (const [index, url] of urls.entries()) {
      const outputs = index % 2 === 0 ? answer.outputs : [...answer.outputs].reverse()
      network.add(url, {
        providers: [
          overlayLookupProvider({
            engine: {
              lookup: async () => ({ type: 'output-list', outputs }),
              provideTopicAnchorTip: async topic => ({
                topic,
                blockHeight: 900,
                tac: 'cd'.repeat(32)
              })
            },
            anchorTopics: { ls_x: ['tm_x'] }
          })
        ]
      })
    }
    const rebuilt = await eqc.lookup({ service: 'ls_x', query: { key: 'value' } })
    expect(
      rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex')).sort()
    ).toEqual([first.txid, second.txid].sort())

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: 'ls_x', query: { key: 'value' } }
    })
    await result.completion
    expect(result.consistency).toEqual([
      expect.objectContaining({ topic: 'tm_x', status: 'agreed', blockHeight: 900 })
    ])
  })

  it('listMessages races the caller own inbox', async () => {
    const { payer, network, eqc } = setup()
    for (const url of urls) {
      network.add(url, {
        providers: [
          messageListProvider({
            listMessages: async (recipient, messageBox) => [
              { messageId: '2', sender: recipient, body: messageBox },
              { messageId: '1', sender: recipient, body: messageBox }
            ]
          })
        ]
      })
    }
    expect(await eqc.listMessages({ messageBox: 'payment_inbox' })).toEqual([
      { messageId: '1', sender: payer.identityKey, body: 'payment_inbox' },
      { messageId: '2', sender: payer.identityKey, body: 'payment_inbox' }
    ])
  })
})
