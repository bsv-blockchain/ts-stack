import type { CreateActionArgs, CreateActionResult } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { verifyAndInternalizePayment } from '../host/paymentVerifier.js'
import type { Attestation } from '../protocol/attestation.js'
import type { Arrival } from './race.js'
import { planPayouts, settle } from './settlement.js'

const queryId = 'a4'.repeat(32)

function ranked(hosts: HostWallet[]): Arrival[] {
  return hosts.map((host, index) => ({
    url: `https://h${index + 1}.example`,
    host: host.identityKey,
    arrivedAt: index,
    attestation: {} as Attestation
  }))
}

describe('planPayouts', () => {
  it('splits the fee by Fibonacci weight in rank order', () => {
    const hosts = Array.from({ length: 5 }, () => new HostWallet())
    expect(planPayouts(ranked(hosts), 1000).map(plan => [plan.rank, plan.satoshis])).toEqual([
      [1, 418],
      [2, 250],
      [3, 166],
      [4, 83],
      [5, 83]
    ])
  })

  it('drops ranks whose share floors to zero', () => {
    const hosts = Array.from({ length: 5 }, () => new HostWallet())
    expect(planPayouts(ranked(hosts), 2).map(plan => [plan.rank, plan.satoshis])).toEqual([[1, 2]])
  })
})

describe('settle', () => {
  it('pays every ranked host from one transaction each host can claim', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet(), new HostWallet()]
    const plans = planPayouts(ranked(hosts), 1000)
    const settlement = await settle(payer, queryId, plans)

    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].options?.randomizeOutputs).toBe(false)
    expect(payer.actions[0].labels).toEqual(['brc178'])
    expect(payer.actions[0].outputs?.map(output => output.satoshis)).toEqual([500, 250, 250])
    expect(settlement.txid).toMatch(/^[0-9a-f]{64}$/)

    for (const [index, host] of hosts.entries()) {
      const envelope = settlement.envelopes.get(host.identityKey)
      if (envelope === undefined) throw new Error('Missing envelope')
      const result = await verifyAndInternalizePayment({
        wallet: host,
        envelope,
        queryId,
        rank: index + 1,
        clientIdentityKey: payer.identityKey,
        requiredSats: plans[index].satoshis
      })
      expect(result).toMatchObject({ ok: true, outputIndex: index })
    }
  })

  it('refuses to settle nothing', async () => {
    await expect(settle(new PayerWallet(), queryId, [])).rejects.toThrow('No payouts')
  })

  it('surfaces a wallet failure', async () => {
    const payer = new PayerWallet()
    payer.failCreateAction = true
    const plans = planPayouts(ranked([new HostWallet()]), 1000)
    await expect(settle(payer, queryId, plans)).rejects.toThrow('Insufficient funds')
  })

  it('rejects a wallet result that omits a planned output', async () => {
    class DroppingWallet extends PayerWallet {
      override async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
        return await super.createAction({ ...args, outputs: args.outputs?.slice(1) })
      }
    }
    const plans = planPayouts(ranked([new HostWallet(), new HostWallet()]), 1000)
    await expect(settle(new DroppingWallet(), queryId, plans)).rejects.toThrow('rank 1')
  })

  it('rejects a wallet result without a transaction', async () => {
    class EmptyWallet extends PayerWallet {
      override async createAction(): Promise<CreateActionResult> {
        return {}
      }
    }
    const plans = planPayouts(ranked([new HostWallet()]), 1000)
    await expect(settle(new EmptyWallet(), queryId, plans)).rejects.toThrow('no transaction')
  })
})
