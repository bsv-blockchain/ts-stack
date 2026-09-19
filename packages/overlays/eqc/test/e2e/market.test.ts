import { Transaction, type LookupAnswer } from '@bsv/sdk'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { EQC } from '../../src/client/EQC.js'
import { createEconomicQueryHost } from '../../src/host/handlers.js'
import { overlayLookupProvider, type QueryProvider } from '../../src/host/providers.js'
import { sampleBeef } from '../support/transactions.js'
import { HostWallet, PayerWallet } from '../support/wallets.js'
import { slapResolver, startHost, type E2EHost } from './harness.js'

const SERVICE = 'ls_e2e'
const first = sampleBeef(1)
const second = sampleBeef(2)
const answer: LookupAnswer = {
  type: 'output-list',
  outputs: [
    { beef: first.beef, outputIndex: 0 },
    { beef: second.beef, outputIndex: 0, context: [7] }
  ]
}

function provider(reverse: boolean): QueryProvider {
  const outputs = reverse ? [...answer.outputs].reverse() : answer.outputs
  return overlayLookupProvider({
    engine: {
      lookup: async () => ({ type: 'output-list', outputs }),
      provideTopicAnchorTip: async topic => ({ topic, blockHeight: 900, tac: 'cd'.repeat(32) })
    },
    anchorTopics: { [SERVICE]: ['tm_e2e'] }
  })
}

const running: E2EHost[] = []

async function start(options: Parameters<typeof startHost>[0]): Promise<E2EHost> {
  const host = await startHost(options)
  running.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async host => await host.close()))
})

describe('economic query market over HTTP', () => {
  it('lets an express Router satisfy RouterLike', () => {
    const router = express.Router()
    createEconomicQueryHost({ wallet: new HostWallet(), providers: [] }).mount(router)
    expect(router.stack).toHaveLength(3)
  })

  it('discovers hosts from SLAP tokens, races them, pays five, and verifies the answer', async () => {
    const hosts = await Promise.all(
      [0, 1, 2, 3, 4].map(async index => await start({ providers: [provider(index % 2 === 1)] }))
    )
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(
        SERVICE,
        hosts.map(host => ({ url: host.url, advertiser: host.wallet }))
      )
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: { key: 'value' } }
    })
    await result.completion

    expect(result.rejected).toEqual([])
    expect(result.ranking).toHaveLength(5)
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([418, 250, 166, 83, 83])
    expect(result.consistency).toEqual([
      expect.objectContaining({ topic: 'tm_e2e', status: 'agreed' })
    ])
    expect(payer.actions).toHaveLength(1)
    for (const host of hosts) {
      expect(host.wallet.internalized).toEqual([expect.objectContaining({ txid: result.txid })])
    }

    const rebuilt = await eqc.lookup({ service: SERVICE, query: { key: 'value' } })
    expect(
      rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex')).sort()
    ).toEqual([first.txid, second.txid].sort())
  }, 30_000)

  it('never pays a host that answers with an HTTP 402 challenge', async () => {
    const honest = await Promise.all(
      [0, 1, 2].map(async () => await start({ providers: [provider(false)] }))
    )
    const greedy = await start({ providers: [provider(false)], demand402Sats: 1_000_000 })
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(
        SERVICE,
        [...honest, greedy].map(host => ({ url: host.url, advertiser: host.wallet }))
      )
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: {} }
    })
    await result.completion

    expect(result.ranking.map(entry => entry.url).sort()).toEqual(
      honest.map(host => host.url).sort()
    )
    expect(result.rejected).toContainEqual(expect.objectContaining({ url: greedy.url }))
    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].description).toBe('BRC-178 query payout')
    expect(payer.actions[0].outputs?.map(output => output.satoshis)).toEqual([500, 250, 250])
    expect(greedy.wallet.internalized).toEqual([])
  }, 30_000)

  it('discards a host whose live identity differs from its SLAP advertisement', async () => {
    const honest = await Promise.all(
      [0, 1, 2].map(async () => await start({ providers: [provider(false)] }))
    )
    const hijacked = await start({ providers: [provider(false)] })
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(SERVICE, [
        ...honest.map(host => ({ url: host.url, advertiser: host.wallet })),
        { url: hijacked.url, advertiser: new HostWallet() }
      ])
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: {} }
    })
    await result.completion

    expect(result.ranking).toHaveLength(3)
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: hijacked.url, reason: 'identity-mismatch' })
    )
    expect(hijacked.wallet.internalized).toEqual([])
  }, 30_000)
})
