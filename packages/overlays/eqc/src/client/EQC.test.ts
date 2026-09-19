import { Transaction, Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { LoopbackNetwork } from '../../test/support/loopback.js'
import { sampleBeef } from '../../test/support/transactions.js'
import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { bytesProvider, messageListProvider, overlayLookupProvider } from '../host/providers.js'
import { EQCError } from '../protocol/errors.js'
import { EQC, type EQCOptions } from './EQC.js'
import { InMemoryReputationStore } from './reputation.js'

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
    raceMs: 60,
    hostTimeoutMs: 400,
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

const request = { type: 'relay-lookup', params: { key: 'k' } }

describe('EQC.query', () => {
  it('pays the five fastest agreeing hosts by arrival order from one transaction', async () => {
    const { payer, network, eqc } = setup()
    const hosts = urls.map((url, index) =>
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: (5 - index) * 8 })
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
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 15 })
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

  it('discards a host whose session key differs from the key it signs with', async () => {
    const { network, eqc } = setup()
    const spoof = network.add(urls[0], { providers: [relay(ANSWER)] })
    spoof.sessionIdentity = new HostWallet().identityKey
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'identity-mismatch' })
    )
    expect(spoof.wallet.internalized).toEqual([])
  })

  it('counts a slow host as late and does not pay it', async () => {
    const { network, eqc } = setup({ raceMs: 30 })
    for (const url of urls.slice(0, 3)) network.add(url, { providers: [relay(ANSWER)] })
    const slow = network.add(urls[3], { providers: [relay(ANSWER)] }, { delayMs: 200 })
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
