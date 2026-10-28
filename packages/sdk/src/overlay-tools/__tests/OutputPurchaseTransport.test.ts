import { jest } from '@jest/globals'
import {
  AuthFetch,
  SimplifiedFetchTransport,
  CompletedProtoWallet,
  OUTPUT_PROFILES,
  signOutputPacket,
  outputPacketDigest
} from '../../../mod.js'
import { OutputPurchaseTransport, OutputPurchaseServiceError } from '../OutputPurchaseTransport.js'
import {
  purchaseTransportFixture,
  purchaseBuyer,
  purchaseSeller
} from './OutputPurchaseTransport.fixture.js'
afterEach(() => jest.restoreAllMocks())
it.each(['submit', 'recover'] as const)(
  'owns an explicitly verified full identity for %s while retaining the original funded request',
  async operation => {
    const f = purchaseTransportFixture(operation),
      candidate = structuredClone(f.candidate),
      binding = {
        profile: 'full-purchase-commitment-v1' as const,
        domainProfile: f.body.domainProfile,
        purchaseCommitment: 'ab'.repeat(32)
      },
      client = new OutputPurchaseTransport({ ...f.options, commitmentBinding: binding }),
      alias = 'cd'.repeat(32),
      evidence = { ...f.evidence, txid: alias },
      packet = {
        result: {
          ...f.envelope.result,
          txid: alias,
          purchaseCommitment: binding.purchaseCommitment,
          potatoes: signOutputPacket(
            'potatoes',
            {
              ...f.potatoes,
              txid: alias,
              purchaseCommitment: binding.purchaseCommitment,
              evidenceDigest: outputPacketDigest('release-evidence', evidence)
            },
            purchaseSeller
          )
        },
        releaseEvidence: evidence
      },
      fetch = jest
        .spyOn(AuthFetch.prototype, 'fetch')
        .mockImplementation(async () => f.response(packet))
    binding.purchaseCommitment = 'ef'.repeat(32)
    f.candidate.txid = '99'.repeat(32)
    expect(await client.send()).toEqual(packet)
    const [url, init] = fetch.mock.calls.at(-1)!
    expect(url).toBe('https://provider.example.test/api/overlay/v1/purchases/' + operation)
    expect(JSON.parse(init!.body as string)).toEqual(
      operation === 'submit' ? candidate : { version: 1, acquisitionId: candidate.acquisitionId }
    )
    expect(JSON.parse(init!.body as string)).not.toHaveProperty('commitmentBinding')
    expect(new Headers(init!.headers).get('x-bsv-payment')).toBeNull()
    // The same response still fails on the historical default transport.
    await expect(f.client.send()).rejects.toThrow('transaction mismatch')
    packet.result.purchaseCommitment = 'ef'.repeat(32)
    packet.result.potatoes = signOutputPacket(
      'potatoes',
      { ...packet.result.potatoes.body, purchaseCommitment: packet.result.purchaseCommitment },
      purchaseSeller
    )
    await expect(client.send()).rejects.toThrow('commitment mismatch')
  }
)
it('requires the explicit local profile, signed domain and original funded candidate before selecting economic binding', () => {
  const f = purchaseTransportFixture('recover'),
    binding = {
      profile: 'full-purchase-commitment-v1' as const,
      domainProfile: f.body.domainProfile,
      purchaseCommitment: 'ab'.repeat(32)
    }
  for (const change of [
    { candidate: undefined },
    { operation: 'prepare' },
    { commitmentBinding: { ...binding, profile: 'unknown' } },
    { commitmentBinding: { ...binding, domainProfile: 'urn:other:domain' } },
    { commitmentBinding: { ...binding, purchaseCommitment: 'ab' } }
  ])
    expect(
      () =>
        new OutputPurchaseTransport({
          ...f.options,
          commitmentBinding: binding,
          ...change
        } as never)
    ).toThrow()
  expect(f.fetchClient).not.toHaveBeenCalled()
})
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
    let expectedRequest: unknown = original
    if (operation === 'submit') expectedRequest = candidate
    if (operation === 'recover')
      expectedRequest = { version: 1, acquisitionId: candidate.acquisitionId }
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://provider.example.test/api/overlay/v1/purchases/' + operation)
      expect(JSON.parse(init!.body as string)).toEqual(expectedRequest)
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

it.each([
  ['trust-kind', 'unsupported', 'Purchase transport requires its explicit topic purchase profile'],
  [
    'trust-profile',
    'unsupported',
    'Purchase transport requires its explicit topic purchase profile'
  ],
  ['topic', 'context-changed', 'Purchase request differs from selected topic or chain'],
  ['chain', 'context-changed', 'Purchase request differs from selected topic or chain'],
  ['wallet', 'invalid', 'Purchase requires an authentication wallet'],
  ['wallet-method', 'invalid', 'Purchase requires an authentication wallet'],
  ['operation', 'unsupported', 'Unknown purchase operation'],
  ['terms', 'invalid', 'Purchase requires original signed terms'],
  ['candidate', 'invalid', 'Purchase submit requires the original signed transaction'],
  ['candidate-identity', 'context-changed', 'Purchase candidate differs from original acquisition']
] as const)('retains the exact %s refusal before HTTP work', (field, code, message) => {
  const f = purchaseTransportFixture('submit'),
    options: Record<string, unknown> = { ...f.options }
  if (field === 'trust-kind') options.trust = { ...f.options.trust, kind: 'lookup' }
  if (field === 'trust-profile')
    options.trust = { ...f.options.trust, profile: OUTPUT_PROFILES.acquisition }
  if (field === 'topic') options.request = { ...f.request, topic: 'other' }
  if (field === 'chain')
    options.request = {
      ...f.request,
      listing: { ...f.request.listing, chain: { ...f.request.listing.chain, network: 'other' } }
    }
  if (field === 'wallet') delete options.wallet
  if (field === 'wallet-method') options.wallet = { getPublicKey: null }
  if (field === 'operation') options.operation = 'other'
  if (field === 'terms') {
    delete options.terms
    delete options.candidate
  }
  if (field === 'candidate') delete options.candidate
  if (field === 'candidate-identity')
    options.candidate = { ...f.candidate, acquisitionId: '99'.repeat(32) }
  expect(() => new OutputPurchaseTransport(options as never)).toThrow(
    expect.objectContaining({ code, message })
  )
  expect(f.fetchClient).not.toHaveBeenCalled()
})

it.each([
  [
    'domain',
    { domainProfile: 'urn:other' },
    'Purchase terms changed selected domain or release policy'
  ],
  [
    'release',
    { releasePolicy: { kind: 'mined', confirmations: 1 } },
    'Purchase terms changed selected domain or release policy'
  ],
  ['recovery', { recoveryUntil: '86500' }, 'Purchase terms shortened selected recovery promise']
] as const)(
  'retains the signed %s policy refusal independently of authentication',
  (field, changed, message) => {
    const f = purchaseTransportFixture('prepare', {}, manifest => {
        // Keep the signed protocol minimum valid while omitting one selected second.
        if (field === 'recovery')
          manifest.services[0].profiles[0].parameters.recoverySeconds = '86401'
      }),
      terms = signOutputPacket('purchase-terms', { ...f.body, ...changed }, purchaseSeller)
    expect(
      () =>
        new OutputPurchaseTransport({
          ...f.options,
          operation: 'submit',
          terms,
          candidate: f.candidate
        })
    ).toThrow(expect.objectContaining({ code: 'context-changed', message }))
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)
it('selects an explicitly advertised release policy without requiring every alternative to match', () => {
  const f = purchaseTransportFixture('submit', {}, manifest => {
    manifest.services[0].profiles[0].parameters.domainProfiles = ['urn:other', 'urn:fixture:domain']
    manifest.services[0].profiles[0].parameters.releasePolicies = [
      { kind: 'mined', confirmations: 1 },
      { kind: 'local-admission' }
    ]
  })
  expect(() => new OutputPurchaseTransport(f.options)).not.toThrow()
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it.each([0, -1, 0.5, 30001, Number.NaN, Number.POSITIVE_INFINITY])(
  'refuses the invalid purchase deadline %s before any dispatch',
  requestTimeoutMs => {
    const f = purchaseTransportFixture('prepare')
    expect(() => new OutputPurchaseTransport({ ...f.options, requestTimeoutMs })).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid purchase deadline' })
    )
    expect(f.fetchClient).not.toHaveBeenCalled()
  }
)
it.each([1, 30000])('accepts the exact purchase deadline %s', requestTimeoutMs => {
  const f = purchaseTransportFixture('prepare')
  expect(() => new OutputPurchaseTransport({ ...f.options, requestTimeoutMs })).not.toThrow()
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it('refuses non-callable fetch and an absent global fallback before any dispatch', () => {
  const f = purchaseTransportFixture('prepare'),
    failure = expect.objectContaining({
      code: 'invalid',
      message: 'Purchase requires a fetch implementation'
    })
  expect(() => new OutputPurchaseTransport({ ...f.options, fetch: 1 } as never)).toThrow(failure)
  const original = globalThis.fetch
  try {
    expect(Reflect.set(globalThis, 'fetch', undefined)).toBe(true)
    expect(() => new OutputPurchaseTransport({ ...f.options, fetch: undefined })).toThrow(failure)
  } finally {
    Reflect.set(globalThis, 'fetch', original)
  }
  expect(f.fetchClient).not.toHaveBeenCalled()
})
it('bounds the request to the selected manifest capacity before dispatch', () => {
  const f = purchaseTransportFixture('prepare'),
    request = { ...f.request, request: Buffer.alloc(1048576).toString('base64') }
  expect(() => new OutputPurchaseTransport({ ...f.options, request })).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
  )
  expect(f.fetchClient).not.toHaveBeenCalled()
})

it.each([
  [
    'contract',
    200,
    { 'x-bsv-overlay-capability': '99'.repeat(32) },
    'context-changed',
    'Purchase response changed original contract'
  ],
  ['payment', 402, {}, 'unsupported', 'Purchase cannot request an HTTP payment'],
  ['status', 500, {}, 'invalid', 'Purchase error status mismatch']
] as const)(
  'retains the authenticated %s refusal after receiving the response',
  async (_field, status, headers, code, message) => {
    const f = purchaseTransportFixture('prepare'),
      packet = { version: 1, error: { code: 'not-found', message: 'Unknown', retryable: false } }
    jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockResolvedValue(f.response(status === 200 ? f.terms : packet, status, headers))
    await expect(f.client.send()).rejects.toMatchObject({ code, message })
  }
)
it.each(['encoding', 'redirect', 'url', 'headers'] as const)(
  'checks the physical %s refusal before authentication or JSON parsing',
  async field => {
    const f = purchaseTransportFixture('prepare'),
      url = 'https://provider.example.test/api/overlay/v1/purchases/prepare',
      headers: Record<string, string> = field === 'encoding' ? { 'content-encoding': 'gzip' } : {},
      response = f.response(f.terms, 200, headers)
    if (field === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
    if (field === 'url')
      Object.defineProperty(response, 'url', { value: 'https://other.example/purchases' })
    if (field === 'headers') response.headers.set('x-large', 'x'.repeat(16385))
    jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
      this: SimplifiedFetchTransport
    ) {
      await this.fetchClient(url, { method: 'POST' })
      throw new Error('Fixture stopped after physical fetch')
    })
    f.fetchClient.mockResolvedValue(response)
    const expected = {
      encoding: { code: 'invalid', message: 'Purchase requires identity encoding' },
      redirect: { code: 'unauthorized', message: 'Purchase response changed endpoint' },
      url: { code: 'unauthorized', message: 'Purchase response changed endpoint' },
      headers: { code: 'limited', message: 'Purchase HTTP header bound' }
    }
    await expect(f.client.send()).rejects.toMatchObject(expected[field])
  }
)
it('bounds physical response bytes to the original selected capacity', async () => {
  const f = purchaseTransportFixture('prepare', {}, manifest => {
      manifest.services[0].profiles[0].maxResponseBytes = 1048576
    }),
    url = 'https://provider.example.test/api/overlay/v1/purchases/prepare'
  jest.spyOn(SimplifiedFetchTransport.prototype, 'send').mockImplementation(async function (
    this: SimplifiedFetchTransport
  ) {
    await this.fetchClient(url, { method: 'POST' })
    throw new Error('Fixture stopped after physical fetch')
  })
  f.fetchClient.mockResolvedValue(f.response('x'.repeat(1048577)))
  await expect(f.client.send()).rejects.toMatchObject({
    code: 'limited',
    message: 'Purchase response byte bound'
  })
})
it('keeps asynchronous identity work bounded and permits retry only after original work settles', async () => {
  const f = purchaseTransportFixture('prepare'),
    wallet = new CompletedProtoWallet(purchaseBuyer),
    original = wallet.getPublicKey
  let release: () => void = () => {
      throw new Error('Missing identity barrier')
    },
    held = true
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  wallet.getPublicKey = async args => {
    if (held) await barrier
    return await original.call(wallet, args)
  }
  const client = new OutputPurchaseTransport({ ...f.options, wallet, requestTimeoutMs: 5 }),
    fetch = jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(f.response(f.terms))
  try {
    await expect(client.send()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Purchase deadline',
      retryable: true
    })
    await expect(client.send()).rejects.toMatchObject({
      code: 'limited',
      message: 'Purchase or earlier I/O is still active'
    })
    expect(fetch).not.toHaveBeenCalled()
    held = false
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await client.send()).toEqual(f.terms)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    held = false
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
})
it('rechecks the exact wallet capability after an authenticated response', async () => {
  const f = purchaseTransportFixture('prepare'),
    original = f.options.wallet.getPublicKey
  jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async () => {
    f.options.wallet.getPublicKey = args => original.call(f.options.wallet, args)
    return f.response(f.terms)
  })
  await expect(f.client.send()).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Private HTTP wallet capability changed'
  })
})
