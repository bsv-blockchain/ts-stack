import { describe, expect, it } from 'vitest'
import { LCHHttpAcquisitionClient } from '@bsv/lch'
import { createFixtureWallet } from '../src/fixtureWallet.js'
import { ReferenceLCHClient } from '../src/referenceClient.js'
import { ReferenceLCHServer } from '../src/referenceServer.js'

describe('reference creator, server, wallet, and player flow', () => {
  it('preflights without spending, then pays every wallet and decrypts the exact asset', async () => {
    const issuer = createFixtureWallet(81)
    const recordingPayee = createFixtureWallet(82)
    const compositionPayee = createFixtureWallet(83)
    const buyer = createFixtureWallet(84)
    const baseUrl = 'http://127.0.0.1:4173'
    const server = await ReferenceLCHServer.create({
      issuerWallet: issuer,
      publicBaseUrl: baseUrl,
      payees: [
        {
          wallet: recordingPayee,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller'
        },
        {
          wallet: compositionPayee,
          satoshis: 5,
          dutyUid: 'urn:lch:duty:composition',
          interest: 'composition',
          label: 'composition controller'
        }
      ]
    })
    const plaintext = new TextEncoder().encode('reference media bytes')
    const published = await server.publish({
      bytes: plaintext,
      mediaType: 'application/octet-stream',
      name: 'reference.bin'
    })
    const client = new ReferenceLCHClient(buyer, server.content, {
      endpointPolicy: {
        allowLocalOrigins: [baseUrl],
        connect: async (url, init) => server.http.handle(new Request(url, init))
      }
    })

    const plan = await client.prepare(published.lch)
    expect(plan.totalSatoshis).toBe(12n)
    expect(plan.readiness).toHaveLength(2)
    expect(plan.demands.map(demand => demand.body.endpoint)).toEqual(
      server.payeeEndpoints.map(item => item.endpoint)
    )
    const http = new LCHHttpAcquisitionClient({
      endpointPolicy: {
        allowLocalOrigins: [baseUrl],
        connect: async (url, init) => server.http.handle(new Request(url, init))
      }
    })
    await expect(
      http.preflightDemand(server.payeeEndpoints[1]!.endpoint, plan.demands[0]!)
    ).rejects.toMatchObject({ code: 'ERR_LCH_DELIVERY' })
    expect(recordingPayee.receivedSatoshis).toBe(0)
    expect(compositionPayee.receivedSatoshis).toBe(0)

    const result = await client.acquire(plan)
    expect(result.plaintext).toEqual(plaintext)
    expect(result.receipts).toHaveLength(2)
    expect(result.transactionId).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.recovered).toBe(true)
    expect(recordingPayee.receivedSatoshis).toBe(7)
    expect(compositionPayee.receivedSatoshis).toBe(5)
    expect(recordingPayee.internalizedActions).toHaveLength(1)
    expect(compositionPayee.internalizedActions).toHaveLength(1)
  })

  it('refuses to create a wallet transaction at the exact Quote expiry boundary', async () => {
    let now = 1_000n
    const recordingPayee = createFixtureWallet(92)
    const compositionPayee = createFixtureWallet(93)
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(91),
      publicBaseUrl: 'https://expiry.test',
      now: () => now,
      payees: [
        {
          wallet: recordingPayee,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller'
        },
        {
          wallet: compositionPayee,
          satoshis: 5,
          dutyUid: 'urn:lch:duty:composition',
          interest: 'composition',
          label: 'composition controller'
        }
      ]
    })
    const published = await server.publish({
      bytes: new TextEncoder().encode('expiry fixture'),
      mediaType: 'text/plain',
      name: 'expiry.txt'
    })
    const client = new ReferenceLCHClient(createFixtureWallet(94), server.content, {
      now: () => now,
      endpointPolicy: {
        allowLocalOrigins: ['https://expiry.test'],
        connect: async (url, init) => server.http.handle(new Request(url, init))
      }
    })
    const plan = await client.prepare(published.lch)
    now = plan.expiresAt
    await expect(client.acquire(plan)).rejects.toThrow(/expired before readiness refresh/u)
    expect(recordingPayee.receivedSatoshis).toBe(0)
    expect(compositionPayee.receivedSatoshis).toBe(0)
  })

  it('retries an ambiguous Payee delivery with the retained transaction instead of paying again', async () => {
    const recordingPayee = createFixtureWallet(112)
    const compositionPayee = createFixtureWallet(113)
    const buyer = createFixtureWallet(114)
    const baseUrl = 'https://recovery.test'
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(111),
      publicBaseUrl: baseUrl,
      payees: [
        {
          wallet: recordingPayee,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller'
        },
        {
          wallet: compositionPayee,
          satoshis: 5,
          dutyUid: 'urn:lch:duty:composition',
          interest: 'composition',
          label: 'composition controller'
        }
      ]
    })
    const published = await server.publish({
      bytes: new TextEncoder().encode('recovery fixture'),
      mediaType: 'text/plain',
      name: 'recovery.txt'
    })
    let deliveryAttempts = 0
    const client = new ReferenceLCHClient(buyer, server.content, {
      endpointPolicy: {
        allowLocalOrigins: [baseUrl],
        connect: async (url, init) => {
          if (new Headers(init.headers).get('content-type')?.includes('type=payment-delivery')) {
            deliveryAttempts += 1
            if (deliveryAttempts === 2) return new Response(null, { status: 503 })
          }
          return server.http.handle(new Request(url, init))
        }
      }
    })
    const plan = await client.prepare(published.lch)
    await expect(client.acquire(plan)).rejects.toMatchObject({ code: 'ERR_LCH_DELIVERY' })
    expect(client.hasPendingPayment()).toBe(true)
    expect(client.pendingPayment()).toMatchObject({
      transactionState: 'finalized',
      settlementState: 'pending-payee-receipts',
      receipts: 1,
      requiredReceipts: 2,
      recoveryUntil: plan.recoveryUntil
    })
    expect(buyer.createdActions).toBe(1)
    expect(recordingPayee.receivedSatoshis).toBe(7)
    expect(compositionPayee.receivedSatoshis).toBe(0)

    await expect(client.acquire(plan)).resolves.toMatchObject({ recovered: true })
    expect(client.hasPendingPayment()).toBe(false)
    expect(buyer.createdActions).toBe(1)
    expect(recordingPayee.receivedSatoshis).toBe(7)
    expect(compositionPayee.receivedSatoshis).toBe(5)
  })
})
