import { jest } from '@jest/globals'
import {
  AuthFetch,
  SimplifiedFetchTransport,
  CompletedProtoWallet,
  OUTPUT_PROFILES,
  signOutputPacket
} from '../../../mod.js'
import { OutputPurchaseTransport, OutputPurchaseServiceError } from '../OutputPurchaseTransport.js'
import {
  purchaseTransportFixture,
  purchaseBuyer,
  purchaseSeller
} from './OutputPurchaseTransport.fixture.js'
afterEach(() => jest.restoreAllMocks())
it.each(['prepare', 'submit', 'recover'] as const)(
  'owns and authenticates the original %s with no HTTP charge',
  async operation => {
    const f = purchaseTransportFixture(operation),
      original = structuredClone(f.request),
      candidate = structuredClone(f.candidate),
      expected = structuredClone(operation === 'prepare' ? f.terms : f.envelope)
    const fetch = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response(expected))
    f.request.request = 'AQ=='
    f.record.manifest.body.baseURL = 'https://other.example'
    f.candidate.txid = '99'.repeat(32)
    f.terms.body.domainEvidence.bytes = 'AQ=='
    expect(await f.client.send()).toEqual(expected)
    expect(await f.client.send()).toEqual(expected)
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://provider.example.test/api/overlay/v1/purchases/' + operation)
      expect(JSON.parse(init!.body as string)).toEqual(
        operation === 'prepare'
          ? original
          : operation === 'submit'
            ? candidate
            : { version: 1, acquisitionId: candidate.acquisitionId }
      )
      expect(init).toMatchObject({
        allowPayments: false,
        requireMutualAuth: true,
        expectedIdentityKey: purchaseSeller.toPublicKey().toString()
      })
      expect(new Headers(init!.headers).get('x-bsv-payment')).toBeNull()
    }
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)
it('rejects wrong profile, service, chain, wallet, operation and candidate before dispatch', () => {
  const f = purchaseTransportFixture('submit')
  for (const change of [
    { trust: { ...f.options.trust, profile: OUTPUT_PROFILES.acquisition } },
    { trust: { ...f.options.trust, kind: 'lookup' } },
    { request: { ...f.request, topic: 'other' } },
    {
      request: {
        ...f.request,
        listing: { ...f.request.listing, chain: { ...f.request.listing.chain, network: 'other' } }
      }
    },
    { wallet: undefined },
    { operation: 'other' },
    { terms: undefined },
    { candidate: undefined },
    { candidate: { ...f.candidate, acquisitionId: '99'.repeat(32) } }
  ])
    expect(() => new OutputPurchaseTransport({ ...f.options, ...change } as never)).toThrow()
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it('rejects signed replacement domain, release terms and shortened selected recovery', () => {
  const f = purchaseTransportFixture('submit')
  for (const change of [
    { domainProfile: 'urn:other' },
    { releasePolicy: { kind: 'mined', confirmations: 1 } },
    { recoveryUntil: '86499' }
  ])
    expect(
      () =>
        new OutputPurchaseTransport({
          ...f.options,
          terms: signOutputPacket('purchase-terms', { ...f.body, ...change }, purchaseSeller)
        })
    ).toThrow()
  const longer = purchaseTransportFixture('prepare', {}, manifest => {
    manifest.services[0].profiles[0].parameters.recoverySeconds = '172800'
  })
  expect(
    () =>
      new OutputPurchaseTransport({
        ...longer.options,
        operation: 'submit',
        terms: longer.terms,
        candidate: longer.candidate
      })
  ).toThrow('shortened')
})
it('authenticates the original recipient before dispatch and bounds delayed identity work', async () => {
  const f = purchaseTransportFixture('prepare')
  const wrong = new CompletedProtoWallet(purchaseSeller)
  await expect(new OutputPurchaseTransport({ ...f.options, wallet: wrong }).send()).rejects.toThrow(
    'recipient'
  )
  expect(f.fetchClient).not.toHaveBeenCalled()
  const wallet = new CompletedProtoWallet(purchaseBuyer)
  wallet.getPublicKey = () => new Promise(() => {})
  const client = new OutputPurchaseTransport({ ...f.options, wallet, requestTimeoutMs: 5 })
  await expect(client.send()).rejects.toThrow('deadline')
  await expect(client.send()).rejects.toThrow('still active')
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it('refuses wallet replacement, cancellation and a changed signed transaction response', async () => {
  const f = purchaseTransportFixture('recover'),
    abort = new AbortController()
  abort.abort()
  await expect(f.client.send(abort.signal)).rejects.toThrow('cancelled')
  const original = f.options.wallet.getPublicKey
  f.options.wallet.getPublicKey = args => original.call(f.options.wallet, args)
  await expect(f.client.send()).rejects.toThrow('capability changed')
  f.options.wallet.getPublicKey = original
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () =>
    f.response({
      result: {
        version: 1,
        acquisitionId: f.body.acquisitionId,
        txid: '99'.repeat(32),
        status: 'admission-pending',
        recoveryUntil: f.body.recoveryUntil
      }
    })
  )
  await expect(f.client.send()).rejects.toThrow('transaction mismatch')
})
it('recovers an original prepared obligation without inventing a candidate or allowing an admitted txid', async () => {
  const f = purchaseTransportFixture('recover', { candidate: undefined })
  const response = {
    result: {
      version: 1,
      acquisitionId: f.body.acquisitionId,
      status: 'prepared',
      recoveryUntil: f.body.recoveryUntil
    }
  }
  const fetch = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(response))
  expect(await f.client.send()).toEqual(response)
  fetch.mockImplementation(async () => f.response(f.envelope))
  await expect(f.client.send()).rejects.toThrow('transaction mismatch')
})
it('bounds response bytes and rejects invalid contract, encoding, endpoint, status and HTTP charge', async () => {
  const f = purchaseTransportFixture('prepare')
  const fetch = jest.spyOn(AuthFetch.prototype, 'fetch')
  for (const response of [
    f.response(f.terms, 200, { 'x-bsv-overlay-capability': '99'.repeat(32) }),
    f.response(f.terms, 402),
    f.response({ error: { code: 'not-found', message: 'Unknown', retryable: false } }, 500)
  ]) {
    fetch.mockResolvedValue(response)
    await expect(f.client.send()).rejects.toThrow()
  }
  fetch.mockResolvedValue(
    f.response(
      { version: 1, error: { code: 'not-found', message: 'Unknown', retryable: false } },
      404
    )
  )
  await expect(f.client.send()).rejects.toBeInstanceOf(OutputPurchaseServiceError)
})

it('checks actual physical response encoding and byte bounds before authentication parsing', async () => {
  const f = purchaseTransportFixture('prepare')
  const url = 'https://provider.example.test/api/overlay/v1/purchases/prepare'
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    await this.fetchClient(url, { method: 'POST' })
    throw new Error('Fixture stopped after physical fetch')
  })
  f.fetchClient.mockImplementation(async () =>
    f.response(f.terms, 200, { 'content-encoding': 'gzip' })
  )
  await expect(f.client.send()).rejects.toThrow('identity encoding')
  f.fetchClient.mockImplementation(async () => f.response('x'.repeat(4194305)))
  await expect(f.client.send()).rejects.toThrow('byte bound')
})
