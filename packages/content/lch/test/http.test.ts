import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHError,
  LCHHttpAcquisitionClient,
  LCHHttpServer,
  WalletBRC77Signer,
  signObject,
  type PaymentCompletion
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('LCH HTTP binding', () => {
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
    const license = await signObject('license', { version: 1, issuer: signer.identityKey }, signer)
    const preflightLicense = jest.fn(async () => undefined)
    const preflightDemand = jest.fn(async () => undefined)
    const quoteHandler = jest.fn(async () => quote)
    const paymentDelivery = jest.fn(async () => receipt)
    const complete = jest.fn(async () => license)
    const recover = jest.fn(async () => license)
    const server = new LCHHttpServer({
      handlers: {
        preflightLicense,
        quote: quoteHandler,
        preflightDemand,
        paymentDelivery,
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
    await client.preflightDemand(endpoint, demand)
    await expect(client.deliver(endpoint, delivery)).resolves.toEqual(receipt)
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
