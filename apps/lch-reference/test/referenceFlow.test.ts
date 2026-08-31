import { describe, expect, it } from 'vitest'
import { LockingScript, Transaction } from '@bsv/sdk'
import {
  LCHHttpAcquisitionClient,
  LCH_SETTLEMENT_PROFILES,
  WalletBRC77Signer,
  signObject
} from '@bsv/lch'
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
    const endpointPolicy = {
      allowLocalOrigins: [baseUrl],
      connect: async (url: URL, init: RequestInit) => server.http.handle(new Request(url, init))
    }
    const client = new ReferenceLCHClient(buyer, server.content, { endpointPolicy })

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
      settlementState: 'pending-settlement-proofs',
      receipts: 1,
      authorizedOutputs: 0,
      requiredProofs: 2,
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

  it('licenses an accepted authorized output while its Payee is offline, then recovers it later', async () => {
    const recordingPayee = createFixtureWallet(122)
    const compositionPayee = createFixtureWallet(123)
    const buyer = createFixtureWallet(124)
    const baseUrl = 'https://authorized-output.test'
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(121),
      publicBaseUrl: baseUrl,
      payees: [
        {
          wallet: recordingPayee,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller',
          settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput
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
    const plaintext = new TextEncoder().encode('offline drummer fixture')
    const published = await server.publish({
      bytes: plaintext,
      mediaType: 'audio/wav',
      name: 'offline.wav'
    })
    const endpointPolicy = {
      allowLocalOrigins: [baseUrl],
      connect: async (url: URL, init: RequestInit) => server.http.handle(new Request(url, init))
    }
    const client = new ReferenceLCHClient(buyer, server.content, { endpointPolicy })
    const plan = await client.prepare(published.lch)
    expect(plan.authorizations).toHaveLength(1)
    server.setPayeeOfflineAfterNextReadiness('recording controller')

    const result = await client.acquire(plan)
    expect(result.plaintext).toEqual(plaintext)
    expect(result.receipts).toHaveLength(1)
    expect(result.authorizedOutputs).toHaveLength(1)
    expect(result.transactionState).toBe('accepted')
    expect(recordingPayee.receivedSatoshis).toBe(0)
    expect(compositionPayee.receivedSatoshis).toBe(5)
    expect(buyer.createdActions).toBe(1)

    const authorized = result.authorizedOutputs[0]!
    const deliveryClient = new LCHHttpAcquisitionClient({ endpointPolicy })
    await expect(
      Promise.all([
        deliveryClient.storeDelivery(
          server.deliveryEndpoint,
          authorized.authorization,
          authorized.delivery
        ),
        deliveryClient.storeDelivery(
          server.deliveryEndpoint,
          authorized.authorization,
          authorized.delivery
        )
      ])
    ).resolves.toEqual([authorized.deliveryAcknowledgement, authorized.deliveryAcknowledgement])
    const conflictingDelivery = await signObject(
      'payment-delivery',
      {
        ...authorized.delivery.body,
        outputIndex: Number(authorized.delivery.body.outputIndex) === 0 ? 1 : 0
      },
      await WalletBRC77Signer.create({ wallet: buyer })
    )
    await expect(
      deliveryClient.storeDelivery(
        server.deliveryEndpoint,
        authorized.authorization,
        conflictingDelivery
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_DELIVERY' })

    server.setPayeeOnline('recording controller', true)
    await expect(server.recoverStoredPayments('recording controller')).resolves.toHaveLength(1)
    expect(recordingPayee.receivedSatoshis).toBe(7)
    expect(recordingPayee.internalizedActions).toHaveLength(1)
    await expect(server.recoverStoredPayments('recording controller')).resolves.toHaveLength(1)
    expect(recordingPayee.receivedSatoshis).toBe(7)
    expect(recordingPayee.internalizedActions).toHaveLength(1)
  })

  it('keeps one finalized payment pending until the authorized Delivery provider returns', async () => {
    const recordingPayee = createFixtureWallet(132)
    const compositionPayee = createFixtureWallet(133)
    const buyer = createFixtureWallet(134)
    const baseUrl = 'https://availability-recovery.test'
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(131),
      publicBaseUrl: baseUrl,
      payees: [
        {
          wallet: recordingPayee,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller',
          settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput
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
      bytes: new TextEncoder().encode('availability fixture'),
      mediaType: 'text/plain',
      name: 'availability.txt'
    })
    const client = new ReferenceLCHClient(buyer, server.content, {
      endpointPolicy: {
        allowLocalOrigins: [baseUrl],
        connect: async (url, init) => server.http.handle(new Request(url, init))
      }
    })
    const plan = await client.prepare(published.lch)
    server.setPayeeOfflineAfterNextReadiness('recording controller')
    server.setAvailabilityProviderOnline(false)
    await expect(client.acquire(plan)).rejects.toMatchObject({ code: 'ERR_LCH_DELIVERY' })
    expect(buyer.createdActions).toBe(1)
    expect(client.pendingPayment()).toMatchObject({
      transactionState: 'finalized',
      receipts: 0,
      authorizedOutputs: 0,
      requiredProofs: 2
    })

    server.setAvailabilityProviderOnline(true)
    await expect(client.acquire(plan)).resolves.toMatchObject({
      receipts: expect.arrayContaining([expect.any(Object)]),
      authorizedOutputs: expect.arrayContaining([expect.any(Object)])
    })
    expect(buyer.createdActions).toBe(1)
  })

  it('keeps receipt-complete settlement pending when an offline Payee has not delegated fallback', async () => {
    const recordingPayee = createFixtureWallet(142)
    const compositionPayee = createFixtureWallet(143)
    const buyer = createFixtureWallet(144)
    const baseUrl = 'https://strict-offline.test'
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(141),
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
      bytes: new TextEncoder().encode('strict fixture'),
      mediaType: 'text/plain',
      name: 'strict.txt'
    })
    const client = new ReferenceLCHClient(buyer, server.content, {
      endpointPolicy: {
        allowLocalOrigins: [baseUrl],
        connect: async (url, init) => server.http.handle(new Request(url, init))
      }
    })
    const plan = await client.prepare(published.lch)
    expect(plan.authorizations).toHaveLength(0)
    server.setPayeeOfflineAfterNextReadiness('recording controller')
    await expect(client.acquire(plan)).rejects.toMatchObject({ code: 'ERR_LCH_DELIVERY' })
    expect(client.hasPendingPayment()).toBe(true)
    expect(buyer.createdActions).toBe(1)
    await expect(server.recover(plan.requestId)).resolves.toBeUndefined()
  })

  it('rejects the wrong output and conflicting accepted transactions for one Authorization', async () => {
    const baseUrl = 'https://transaction-evidence.test'
    const server = await ReferenceLCHServer.create({
      issuerWallet: createFixtureWallet(151),
      publicBaseUrl: baseUrl,
      payees: [
        {
          wallet: createFixtureWallet(152),
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          interest: 'recording',
          label: 'recording controller',
          settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput
        },
        {
          wallet: createFixtureWallet(153),
          satoshis: 5,
          dutyUid: 'urn:lch:duty:composition',
          interest: 'composition',
          label: 'composition controller'
        }
      ]
    })
    const published = await server.publish({
      bytes: new TextEncoder().encode('evidence fixture'),
      mediaType: 'text/plain',
      name: 'evidence.txt'
    })
    const endpointPolicy = {
      allowLocalOrigins: [baseUrl],
      connect: async (url: URL, init: RequestInit) => server.http.handle(new Request(url, init))
    }
    const plan = await new ReferenceLCHClient(createFixtureWallet(154), server.content, {
      endpointPolicy
    }).prepare(published.lch)
    const authorization = plan.authorizations[0]!
    const http = new LCHHttpAcquisitionClient({ endpointPolicy })
    const wrong = new Transaction(
      1,
      [],
      [{ satoshis: 7, lockingScript: LockingScript.fromHex('51') }]
    )
    await expect(
      http.attestTransaction(
        server.evidenceEndpoint,
        authorization,
        Uint8Array.from(wrong.toAtomicBEEF(true))
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_PAYMENT' })

    const output = {
      satoshis: 7,
      lockingScript: LockingScript.fromHex(
        Array.from(authorization.body.lockingScript as Uint8Array, value =>
          value.toString(16).padStart(2, '0')
        ).join('')
      )
    }
    const first = new Transaction(1, [], [output], 0)
    const conflicting = new Transaction(1, [], [output], 1)
    await expect(
      http.attestTransaction(
        server.evidenceEndpoint,
        authorization,
        Uint8Array.from(first.toAtomicBEEF(true))
      )
    ).resolves.toMatchObject({ body: { state: 'accepted' } })
    await expect(
      http.attestTransaction(
        server.evidenceEndpoint,
        authorization,
        Uint8Array.from(conflicting.toAtomicBEEF(true))
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_PAYMENT' })
  })
})
