import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { paymentEnvelope, payoutLockingScript } from '../protocol/payment.js'
import { verifyAndInternalizePayment } from './paymentVerifier.js'

const queryId = 'a4'.repeat(32)

async function payout(
  payer: PayerWallet,
  hosts: HostWallet[],
  satoshis: number[]
): Promise<number[]> {
  const outputs = await Promise.all(
    hosts.map(async (host, index) => ({
      lockingScript: await payoutLockingScript(payer, host.identityKey, queryId, index + 1, false),
      satoshis: satoshis[index],
      outputDescription: `Rank ${index + 1} payout`
    }))
  )
  const result = await payer.createAction({ description: 'BRC-178 query payout', outputs })
  if (result.tx === undefined) throw new Error('No transaction')
  return Array.from(result.tx)
}

describe('verifyAndInternalizePayment', () => {
  it('finds and internalizes its own output at a non-zero index', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet(), new HostWallet()]
    const transaction = await payout(payer, hosts, [500, 250, 250])
    const result = await verifyAndInternalizePayment({
      wallet: hosts[1],
      envelope: paymentEnvelope(queryId, 2, transaction),
      queryId,
      rank: 2,
      clientIdentityKey: payer.identityKey,
      requiredSats: 250
    })
    expect(result).toMatchObject({ ok: true, outputIndex: 1, satoshis: 250 })
    expect(hosts[1].internalized).toEqual([
      expect.objectContaining({ outputIndex: 1, satoshis: 250, sender: payer.identityKey })
    ])
  })

  it('reports underpayment without touching the wallet', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    const transaction = await payout(payer, [host], [100])
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, transaction),
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 250
    })
    expect(result).toEqual({ ok: false, reason: 'underpaid', required: 250, paid: 100 })
    expect(host.internalized).toEqual([])
  })

  it('finds nothing when the transaction pays another rank', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet()]
    const transaction = await payout(payer, hosts, [500, 250])
    const result = await verifyAndInternalizePayment({
      wallet: hosts[0],
      envelope: paymentEnvelope(queryId, 2, transaction),
      queryId,
      rank: 2,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'no-output' })
  })

  it('rejects an envelope bound to another query or another rank', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    const transaction = await payout(payer, [host], [500])
    const base = {
      wallet: host,
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    }
    expect(
      await verifyAndInternalizePayment({
        ...base,
        envelope: paymentEnvelope('b5'.repeat(32), 1, transaction)
      })
    ).toEqual({ ok: false, reason: 'malformed' })
    expect(
      await verifyAndInternalizePayment({
        ...base,
        envelope: paymentEnvelope(queryId, 2, transaction)
      })
    ).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects bytes that are not Atomic BEEF', async () => {
    const host = new HostWallet()
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, [1, 2, 3]),
      queryId,
      rank: 1,
      clientIdentityKey: new PayerWallet().identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('reports a wallet refusal as rejected', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    host.rejectPayments = true
    const transaction = await payout(payer, [host], [500])
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, transaction),
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'rejected' })
  })
})
