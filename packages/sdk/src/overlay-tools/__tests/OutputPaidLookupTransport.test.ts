import { jest } from '@jest/globals'
import {
  AuthFetch,
  CompletedProtoWallet,
  SimplifiedFetchTransport,
  OUTPUT_PROFILES,
  canonicalOutputJSON,
  signOutputPacket
} from '../../../mod.js'
import {
  OutputPaidLookupServiceError,
  OutputPaidLookupTransport
} from '../OutputPaidLookupTransport.js'
import { paidTransportFixture, paidBuyer, paidSeller } from './OutputPaidLookupTransport.fixture.js'
afterEach(() => jest.restoreAllMocks())
const tick = async () => await new Promise<void>(resolve => setImmediate(resolve))

it.each(['quote', 'pay', 'recover'] as const)(
  'owns the original %s operation across retries and manifest expiry',
  async operation => {
    const f = paidTransportFixture(operation),
      original = structuredClone(f.request),
      payment = structuredClone(f.payment)
    const expected =
      operation === 'quote'
        ? { kind: 'challenge', challenge: structuredClone(f.challenge) }
        : structuredClone(f.delivered)
    const send = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response())
    f.options.request = { replacement: true }
    f.record.manifest.body.baseURL = 'https://other.example'
    f.record.selectedAt = '999999'
    expect(await f.client.send()).toEqual(expected)
    expect(await f.client.send()).toEqual(expected)
    for (const [url, init] of send.mock.calls) {
      expect(url).toBe(
        'https://provider.example.test/api/overlay/v1/private/' +
          (operation === 'recover' ? 'recover' : 'acquire')
      )
      expect(JSON.parse(init!.body as string)).toEqual(
        operation === 'recover'
          ? { version: 1, acquisitionId: f.challenge.acquisitionId }
          : original
      )
      expect(init).toMatchObject({
        method: 'POST',
        allowPayments: false,
        requireMutualAuth: true,
        expectedIdentityKey: paidSeller.toPublicKey().toString(),
        headers: {
          'x-bsv-overlay-profile': OUTPUT_PROFILES.acquisition,
          'x-bsv-overlay-capability': f.selection.digest
        }
      })
      const headers = new Headers(init!.headers)
      expect(headers.get('x-bsv-payment')).toBe(
        operation === 'pay' ? canonicalOutputJSON(payment) : null
      )
    }
    expect(send).toHaveBeenCalledTimes(2)
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)
it('owns saved quote and payment objects before caller mutation', async () => {
  const f = paidTransportFixture('pay'),
    original = structuredClone(f.delivered),
    payment = structuredClone(f.payment)
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(original))
  f.challenge.satoshis = '999'
  f.payment.transaction = 'AQ=='
  f.payment.derivationPrefix = 'changed'
  expect(await f.client.send()).toEqual(original)
  expect(JSON.parse(new Headers(send.mock.calls[0][1]!.headers).get('x-bsv-payment')!)).toEqual(
    payment
  )
})
it.each(['kind', 'profile'] as const)('rejects a wrong selected %s before I/O', key => {
  const f = paidTransportFixture('quote')
  expect(
    () =>
      new OutputPaidLookupTransport({
        ...f.options,
        trust: { ...f.options.trust, [key]: 'other' } as never
      })
  ).toThrow('acquisition profile')
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it('requires a supported operation, callable authentication wallet and exact selected request', () => {
  const f = paidTransportFixture('quote')
  expect(() => new OutputPaidLookupTransport({ ...f.options, wallet: undefined as never })).toThrow(
    'wallet'
  )
  expect(
    () => new OutputPaidLookupTransport({ ...f.options, operation: 'other' } as never)
  ).toThrow('operation')
  for (const request of [
    { ...f.request, service: 'other' },
    {
      ...f.request,
      listing: { ...f.request.listing, chain: { ...f.request.listing.chain, network: 'other' } }
    }
  ])
    expect(() => new OutputPaidLookupTransport({ ...f.options, request })).toThrow(
      'service or chain'
    )
})
it('requires HTTPS independently of another profile local-HTTP exception', () => {
  const f = paidTransportFixture('quote'),
    manifest = structuredClone(f.record.manifest.body)
  manifest.baseURL = 'http://localhost/api'
  expect(
    () =>
      new OutputPaidLookupTransport({
        ...f.options,
        contract: { ...f.record, manifest: signOutputPacket('capabilities', manifest, paidSeller) },
        trust: { ...f.options.trust, baseURL: manifest.baseURL, allowLocalHTTP: true }
      })
  ).toThrow()
})
it('binds saved payment to its original quote without treating representation as Script acceptance', () => {
  const f = paidTransportFixture('pay')
  expect(() => new OutputPaidLookupTransport({ ...f.options, challenge: undefined })).toThrow(
    'original challenge'
  )
  expect(
    () =>
      new OutputPaidLookupTransport({
        ...f.options,
        payment: { ...f.payment, derivationPrefix: 'other' }
      })
  ).toThrow('original prefix')
  expect(
    () =>
      new OutputPaidLookupTransport({
        ...f.options,
        payment: { ...f.payment, transaction: Buffer.alloc(65537).toString('base64') }
      })
  ).toThrow()
})
it.each([
  'buyer',
  'seller',
  'requestDigest',
  'assetId',
  'termsDigest',
  'rulesDigest',
  'acquisitionId'
] as const)('binds challenge %s to the original request', async field => {
  const f = paidTransportFixture('quote'),
    challenge = {
      ...f.challenge,
      [field]:
        field === 'buyer'
          ? f.challenge.seller
          : field === 'seller'
            ? f.challenge.buyer
            : 'ff'.repeat(32)
    }
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(challenge))
  await expect(f.client.send()).rejects.toThrow('selected request')
})
it('binds release policy and the selected recovery promise without rewriting historical dates', async () => {
  const f = paidTransportFixture('quote', {}, manifest => {
    manifest.services[0].profiles[0].parameters.recoverySeconds = '90000'
  })
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  await expect(f.client.send()).rejects.toThrow('recovery promise')
  send.mockImplementation(async () => f.response({ ...f.challenge, recoveryUntil: '90100' }))
  expect(await f.client.send()).toMatchObject({
    kind: 'challenge',
    challenge: { payableUntil: '100', recoveryUntil: '90100' }
  })
  send.mockImplementation(async () =>
    f.response({
      ...f.challenge,
      recoveryUntil: '90100',
      acceptancePolicy: { kind: 'mined', confirmations: 1 }
    })
  )
  await expect(f.client.send()).rejects.toThrow('acceptance policy')
})
it.each([
  'x-bsv-auth-identity-key',
  'x-bsv-overlay-capability',
  'x-bsv-overlay-profile',
  'x-bsv-payment-version',
  'x-bsv-payment-satoshis-required',
  'x-bsv-payment-derivation-prefix'
] as const)('rejects changed signed response header %s', async header => {
  const f = paidTransportFixture('quote')
  jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(undefined, 402, { [header]: 'changed' }))
  await expect(f.client.send()).rejects.toThrow()
})
it.each(['pay', 'recover'] as const)(
  'refuses a new challenge during %s, without asking the wallet to pay',
  async operation => {
    const f = paidTransportFixture(operation),
      create = jest.spyOn(f.options.wallet, 'createAction')
    jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response(f.challenge, 402))
    await expect(f.client.send()).rejects.toMatchObject({ code: 'unsupported' })
    expect(create).not.toHaveBeenCalled()
  }
)
it.each([
  'x-bsv-payment-version',
  'x-bsv-payment-satoshis-required',
  'x-bsv-payment-derivation-prefix'
])('rejects payment header %s on an uncharged status', async header => {
  const f = paidTransportFixture('recover')
  jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(undefined, 200, { [header]: 'unexpected' }))
  await expect(f.client.send()).rejects.toThrow('Non-challenge')
})
it('allows lost-quote recovery but binds any returned quote to the exact retained request', async () => {
  const f = paidTransportFixture('recover', { challenge: undefined }),
    send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  expect(await f.client.send()).toEqual(f.delivered)
  send.mockImplementation(async () =>
    f.response({ ...f.quoted, challenge: { ...f.challenge, requestDigest: 'ff'.repeat(32) } })
  )
  await expect(f.client.send()).rejects.toThrow('selected request')
})
it('returns saved quoted status on repeated Acquire without converting it into payment authority', async () => {
  const f = paidTransportFixture('quote')
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response(f.quoted, 200))
  expect(await f.client.send()).toEqual({ kind: 'status', response: f.quoted })
})
it('rejects a changed original price and substituted delivered output', async () => {
  const f = paidTransportFixture('pay'),
    send = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () =>
        f.response({ ...f.delivered, challenge: { ...f.challenge, satoshis: '101' } })
      )
  await expect(f.client.send()).rejects.toThrow('frozen challenge')
  send.mockImplementation(async () =>
    f.response({
      ...f.delivered,
      result: {
        ...f.delivered.result,
        evidence: { ...f.delivered.result!.evidence, outputIndex: 0 }
      }
    })
  )
  await expect(f.client.send()).rejects.toThrow('frozen output')
})
it('preserves authenticated service errors and refuses mismatched HTTP status', async () => {
  const f = paidTransportFixture('recover'),
    packet = {
      version: 1,
      error: { code: 'not-found', message: 'No acquisition', retryable: false }
    }
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => f.response(packet, 404))
  await expect(f.client.send()).rejects.toBeInstanceOf(OutputPaidLookupServiceError)
  send.mockImplementation(async () => f.response(packet, 409))
  await expect(f.client.send()).rejects.toThrow('status mismatch')
  const error = new OutputPaidLookupServiceError(packet as never)
  packet.error.message = 'changed'
  expect(error).toMatchObject({
    name: 'OutputPaidLookupServiceError',
    message: 'No acquisition',
    packet: { error: { message: 'No acquisition' } }
  })
})
it('checks selected byte bounds before dispatch and before decoding a challenge', async () => {
  const reference = paidTransportFixture('quote'),
    requestBytes = Buffer.byteLength(canonicalOutputJSON(reference.request)),
    responseBytes = Buffer.byteLength(JSON.stringify(reference.challenge))
  expect(() =>
    paidTransportFixture('quote', {}, m => {
      m.services[0].profiles[0].maxRequestBytes = requestBytes - 1
    })
  ).toThrow()
  const exact = paidTransportFixture('quote', {}, m => {
    m.services[0].profiles[0].maxRequestBytes = requestBytes
    m.services[0].profiles[0].maxResponseBytes = responseBytes
  })
  const small = paidTransportFixture('quote', {}, m => {
    m.services[0].profiles[0].maxResponseBytes = responseBytes - 1
  })
  const send = jest
    .spyOn(AuthFetch.prototype, 'fetch')
    .mockImplementation(async () => exact.response())
  expect(await exact.client.send()).toMatchObject({ kind: 'challenge' })
  send.mockImplementation(async () => small.response())
  await expect(small.client.send()).rejects.toMatchObject({ name: 'LookupResourceLimitError' })
})
it('authenticates with the original buyer and rejects changed wallet capability before dispatch', async () => {
  const f = paidTransportFixture('quote'),
    send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => f.response())
  const replacement = new CompletedProtoWallet(paidSeller)
  f.options.wallet.getPublicKey = replacement.getPublicKey.bind(replacement)
  await expect(f.client.send()).rejects.toThrow('capability changed')
  const other = paidTransportFixture('quote', { wallet: new CompletedProtoWallet(paidSeller) })
  await expect(other.client.send()).rejects.toThrow('original buyer')
  expect(send).not.toHaveBeenCalled()
})
it('retains physical capacity for a timed-out identity lookup before any HTTP effect', async () => {
  let settle!: (value: { publicKey: string }) => void
  const wallet = new CompletedProtoWallet(paidBuyer)
  wallet.getPublicKey = async () =>
    await new Promise(resolve => {
      settle = resolve
    })
  const f = paidTransportFixture('quote', { wallet, requestTimeoutMs: 5 }),
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await expect(f.client.send()).rejects.toThrow('deadline')
  await expect(f.client.send()).rejects.toThrow('still active')
  settle({ publicKey: paidBuyer.toPublicKey().toString() })
  await tick()
  expect(send).not.toHaveBeenCalled()
})
it('keeps cancelled physical HTTP owned until settlement, then retries identical bytes', async () => {
  const f = paidTransportFixture('pay'),
    controller = new AbortController()
  let settle!: (response: Response) => void
  const send = jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(
    async () =>
      await new Promise(resolve => {
        settle = resolve
      })
  )
  const first = f.client.send(controller.signal)
  await tick()
  controller.abort()
  await expect(first).rejects.toMatchObject({ code: 'cancelled' })
  await expect(f.client.send()).rejects.toMatchObject({ code: 'limited' })
  settle(f.response())
  await tick()
  send.mockImplementation(async () => f.response())
  expect(await f.client.send()).toEqual(f.delivered)
  expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1])
})
it.each([0, -1, 30001, 1.5, NaN])('rejects invalid request timeout %s', requestTimeoutMs => {
  expect(() => paidTransportFixture('quote', { requestTimeoutMs })).toThrow('deadline')
})
it('requires a callable fetch and avoids work for an already cancelled request', async () => {
  expect(() => paidTransportFixture('quote', { fetch: 42 as never })).toThrow('fetch')
  const f = paidTransportFixture('quote'),
    controller = new AbortController(),
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  controller.abort()
  await expect(f.client.send(controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
  expect(send).not.toHaveBeenCalled()
})
it.each(['endpoint', 'redirect', 'headers', 'encoding', 'body'] as const)(
  'bounds the actual authentication fetch: %s',
  async kind => {
    const f = paidTransportFixture('quote', {}, m => {
      m.services[0].profiles[0].maxResponseBytes = 128
    })
    const endpoint = 'https://provider.example.test/api/overlay/v1/private/acquire'
    const response = f.response(kind === 'body' ? 'x'.repeat(129) : '{}')
    if (kind === 'redirect')
      Object.defineProperty(response, 'url', { value: 'https://other.example' })
    if (kind === 'headers') response.headers.set('x-padding', 'x'.repeat(16385))
    if (kind === 'encoding') response.headers.set('content-encoding', 'gzip')
    f.fetchClient.mockResolvedValue(response)
    jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
      this: SimplifiedFetchTransport
    ) {
      await this.fetchClient(kind === 'endpoint' ? 'https://other.example' : endpoint, {
        method: 'POST'
      })
      throw new Error('Fixture expected bounded exchange rejection')
    })
    const expected = {
      endpoint: 'changed endpoint',
      redirect: 'changed endpoint',
      headers: 'header limit',
      encoding: 'identity encoding',
      body: 'byte limit'
    }
    await expect(f.client.send()).rejects.toThrow(expected[kind])
    if (kind === 'endpoint') expect(f.fetchClient).not.toHaveBeenCalled()
    else
      expect(f.fetchClient).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'omit' })
      )
  }
)
