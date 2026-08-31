import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHError,
  LCHHttpAcquisitionClient,
  LCHHttpServer,
  WalletBRC77Signer,
  encodeDeterministicCbor,
  signObject,
  type PaymentCompletion
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('LCH HTTP binding', () => {
  it('answers CORS preflight and rejects wrong methods and unregistered message types', async () => {
    const endpoint = 'https://lch.test/acquisition'
    const server = new LCHHttpServer({ handlers: {}, allowOrigin: 'https://player.test' })
    const options = await server.handle(new Request(endpoint, { method: 'OPTIONS' }))
    expect(options.status).toBe(204)
    expect(options.headers.get('access-control-allow-origin')).toBe('https://player.test')
    await expect(server.handle(new Request(endpoint))).resolves.toMatchObject({ status: 405 })
    const unsupported = await server.handle(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.bsv.lch+cbor; type=future-transport'
        },
        body: encodeDeterministicCbor(null).slice().buffer
      })
    )
    expect(unsupported.status).toBe(415)
  })

  it('routes every acquisition message as bounded deterministic CBOR', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(71))
    })
    const request = await signObject(
      'license-request',
      { version: 1, buyer: signer.identityKey },
      signer
    )
    const quote = await signObject('quote', { version: 1 }, signer)
    const demand = await signObject(
      'payment-demand',
      { version: 1, payee: signer.identityKey },
      signer
    )
    const readiness = await signObject(
      'payment-readiness',
      { version: 1, payee: signer.identityKey },
      signer
    )
    const authorization = await signObject(
      'payment-authorization',
      { version: 1, payee: signer.identityKey },
      signer
    )
    const delivery = await signObject(
      'payment-delivery',
      { version: 1, buyer: signer.identityKey },
      signer
    )
    const receipt = await signObject(
      'payment-receipt',
      { version: 1, payee: signer.identityKey },
      signer
    )
    const evidence = await signObject(
      'transaction-evidence',
      { version: 1, provider: signer.identityKey },
      signer
    )
    const acknowledgement = await signObject(
      'payment-delivery-ack',
      { version: 1, provider: signer.identityKey },
      signer
    )
    const retrieval = await signObject(
      'payment-delivery-retrieval',
      { version: 1, payee: signer.identityKey },
      signer
    )
    const license = await signObject('license', { version: 1, issuer: signer.identityKey }, signer)
    const preflightLicense = jest.fn(async () => undefined)
    const preflightDemand = jest.fn(async () => readiness)
    const quoteHandler = jest.fn(async () => quote)
    const paymentDelivery = jest.fn(async () => receipt)
    const authorizePayment = jest.fn(async () => authorization)
    const storeDelivery = jest.fn(async () => acknowledgement)
    const attestTransaction = jest.fn(async () => evidence)
    const retrieveDelivery = jest.fn(async () => ({
      authorization,
      delivery,
      deliveryAcknowledgement: acknowledgement
    }))
    const complete = jest.fn(async () => license)
    const recover = jest.fn(async () => license)
    const server = new LCHHttpServer({
      handlers: {
        preflightLicense,
        quote: quoteHandler,
        preflightDemand,
        authorizePayment,
        paymentDelivery,
        storeDelivery,
        attestTransaction,
        retrieveDelivery,
        complete,
        recover
      }
    })
    const endpoint = 'https://lch.test/acquisition'
    const client = new LCHHttpAcquisitionClient({
      endpointPolicy: {
        allowLocalOrigins: ['https://lch.test'],
        connect: async (url, init) => server.handle(new Request(url, init))
      }
    })
    await client.preflightLicense(endpoint, request)
    await expect(client.quote(endpoint, request)).resolves.toEqual(quote)
    await expect(client.preflightDemand(endpoint, demand)).resolves.toEqual(readiness)
    await expect(client.authorizePayment(endpoint, demand)).resolves.toEqual(authorization)
    await expect(client.deliver(endpoint, delivery)).resolves.toEqual(receipt)
    await expect(client.storeDelivery(endpoint, authorization, delivery)).resolves.toEqual(
      acknowledgement
    )
    await expect(client.attestTransaction(endpoint, authorization, bytes(9, 4))).resolves.toEqual(
      evidence
    )
    await expect(client.retrieveDelivery(endpoint, retrieval)).resolves.toEqual({
      authorization,
      delivery,
      deliveryAcknowledgement: acknowledgement
    })
    const completion: PaymentCompletion = {
      request,
      quote,
      atomicBeef: bytes(1, 4),
      receipts: [receipt]
    }
    await expect(client.complete(endpoint, completion)).resolves.toEqual(license)
    await expect(client.recover(endpoint, bytes(2, 32))).resolves.toEqual(license)
    expect(preflightLicense).toHaveBeenCalledWith(request)
    expect(quoteHandler).toHaveBeenCalledWith(request)
    expect(preflightDemand).toHaveBeenCalledWith(demand)
    expect(paymentDelivery).toHaveBeenCalledWith(delivery)
    expect(authorizePayment).toHaveBeenCalledWith(demand)
    expect(storeDelivery).toHaveBeenCalledWith({ authorization, delivery })
    expect(attestTransaction).toHaveBeenCalledWith({ authorization, atomicBeef: bytes(9, 4) })
    expect(retrieveDelivery).toHaveBeenCalledWith(retrieval)
    expect(complete.mock.calls[0]?.[0]).toEqual(completion)
  })

  it('returns undefined for an unknown recovery and rejects unsupported media types', async () => {
    const server = new LCHHttpServer({ handlers: { recover: async () => undefined } })
    const endpoint = 'https://lch.test/acquisition'
    const client = new LCHHttpAcquisitionClient({
      endpointPolicy: {
        allowLocalOrigins: ['https://lch.test'],
        connect: async (url, init) => server.handle(new Request(url, init))
      }
    })
    await expect(client.recover(endpoint, bytes(3, 32))).resolves.toBeUndefined()
    const response = await server.handle(
      new Request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toBe('application/vnd.bsv.lch+cbor; type=error')
  })

  it('propagates a bounded stable LCH error envelope instead of reducing it to HTTP status', async () => {
    const server = new LCHHttpServer({
      handlers: {
        recover: async () => {
          throw new LCHError('ERR_LCH_AUTHORITY', 'issuer authority is unavailable')
        }
      }
    })
    const client = new LCHHttpAcquisitionClient({
      endpointPolicy: {
        allowLocalOrigins: ['https://lch.test'],
        connect: async (url, init) => server.handle(new Request(url, init))
      }
    })
    await expect(
      client.recover('https://lch.test/acquisition', bytes(7, 32))
    ).rejects.toMatchObject({ code: 'ERR_LCH_AUTHORITY' })
  })

  it('enforces request body bounds while streaming', async () => {
    const server = new LCHHttpServer({ handlers: {}, maximumRequestBytes: 4 })
    const response = await server.handle(
      new Request('https://lch.test/acquisition', {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.bsv.lch+cbor; type=license-request' },
        body: bytes(1, 5).slice().buffer
      })
    )
    expect(response.status).toBe(422)
  })
})
