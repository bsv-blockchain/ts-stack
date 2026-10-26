import { acquisitionNativeWalletFixture } from '../../../../application/output-knowledge/test/private-acquisition-wallet.fixture.js'
import { expect, it, jest } from '@jest/globals'
import {
  CompletedProtoWallet,
  PrivateKey,
  retainOutputCapability,
  type OutputCapabilityRequest
} from '@bsv/sdk'
import { OutputPaidLookupTransport } from '../../../../sdk/src/overlay-tools/OutputPaidLookupTransport.js'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'

async function clientFixture(...options: Parameters<typeof privateAcquisitionHTTPFixture>) {
  const f = await privateAcquisitionHTTPFixture(...options)
  const installation = f.contract.installation
  const trust: OutputCapabilityRequest = {
    ...f.f.f.trust,
    baseURL: installation.baseURL,
    identity: installation.seller,
    chain: installation.chain,
    service: installation.service,
    profile: f.caller.profile,
    kind: 'lookup',
    now: '20'
  }
  const { record } = retainOutputCapability(f.f.f.manifest(), trust)
  const wallet = new CompletedProtoWallet(new PrivateKey(84))
  const create = jest.spyOn(wallet, 'createAction')
  const requests: { path: string; headers: Headers; body: string | undefined }[] = []
  let loseApplicationReply = false
  const wire: typeof fetch = async (input, init) => {
    const selected = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    if (selected.origin !== new URL(installation.baseURL).origin)
      throw new Error('Fixture unexpected selected endpoint')
    requests.push({
      path: selected.pathname,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined
    })
    // Isolated loopback fixture only: production client still selects HTTPS and
    // authenticates the actual server. No network certificate validation claim.
    const response = await fetch(f.origin + selected.pathname, init)
    const bytes = await response.arrayBuffer()
    if (loseApplicationReply && selected.pathname.endsWith('/acquire')) {
      loseApplicationReply = false
      throw new Error('Synthetic lost authenticated application reply')
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
  const common = {
    contract: record,
    trust,
    request: f.request,
    wallet,
    fetch: wire,
    requestTimeoutMs: 10000
  }
  return {
    ...f,
    common,
    requests,
    create,
    loseReply() {
      loseApplicationReply = true
    }
  }
}
it('uses the finite SDK against authenticated quote/payment/recovery routes with one credit', async () => {
  const f = await clientFixture()
  try {
    const quote = await new OutputPaidLookupTransport({ ...f.common, operation: 'quote' }).send()
    expect(quote.kind).toBe('challenge')
    if (quote.kind !== 'challenge') throw new Error('Expected retained quote')
    const original = structuredClone(quote.challenge)
    const paid = await new OutputPaidLookupTransport({
      ...f.common,
      operation: 'pay',
      challenge: original,
      payment: f.payment
    }).send()
    expect(paid).toMatchObject({
      status: 'delivered',
      challenge: original,
      result: { context: 'AQID' }
    })
    const recovered = await new OutputPaidLookupTransport({
      ...f.common,
      operation: 'recover',
      challenge: original
    }).send()
    expect(recovered).toEqual(paid)
    expect(f.getCredits()).toBe(1)
    expect(f.create).not.toHaveBeenCalled()
    const applications = f.requests.filter(request => request.path !== '/.well-known/auth')
    expect(
      applications.map(request => [request.path, request.headers.has('x-bsv-payment')])
    ).toEqual([
      ['/api/overlay/v1/private/acquire', false],
      ['/api/overlay/v1/private/acquire', true],
      ['/api/overlay/v1/private/recover', false]
    ])
    expect(applications.every(request => request.headers.get('cache-control') === 'no-store')).toBe(
      true
    )
  } finally {
    await f.close()
  }
}, 30000)
it('recovers a lost paid reply under the original contract without constructing or resending payment', async () => {
  const f = await clientFixture()
  try {
    const quote = await new OutputPaidLookupTransport({ ...f.common, operation: 'quote' }).send()
    if (quote.kind !== 'challenge') throw new Error('Expected retained quote')
    f.loseReply()
    await expect(
      new OutputPaidLookupTransport({
        ...f.common,
        operation: 'pay',
        challenge: quote.challenge,
        payment: f.payment
      }).send()
    ).rejects.toThrow('lost authenticated')
    expect(f.getCredits()).toBe(1)
    f.f.setNow('200')
    const response = await new OutputPaidLookupTransport({
      ...f.common,
      operation: 'recover',
      challenge: quote.challenge
    }).send()
    expect(response).toMatchObject({ status: 'delivered', challenge: quote.challenge })
    expect(f.getCredits()).toBe(1)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.requests.filter(request => request.headers.has('x-bsv-payment'))).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 30000)
it('recovers a lost original quote and keeps a currently withdrawn buyer inaccessible', async () => {
  const f = await clientFixture()
  try {
    f.loseReply()
    await expect(
      new OutputPaidLookupTransport({ ...f.common, operation: 'quote' }).send()
    ).rejects.toThrow('lost authenticated')
    const recovered = await new OutputPaidLookupTransport({
      ...f.common,
      operation: 'recover'
    }).send()
    expect(recovered.status).toBe('quoted')
    f.setAccess(false)
    await expect(
      new OutputPaidLookupTransport({
        ...f.common,
        operation: 'recover',
        challenge: recovered.challenge
      }).send()
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(f.getCredits()).toBe(0)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.requests.every(request => !request.headers.has('x-bsv-payment'))).toBe(true)
  } finally {
    await f.close()
  }
}, 30000)
it('recovers a lost SDK reply after one actual native wallet credit without broadcasting', async () => {
  const { PrivateAcquisitionCoordinator } =
    await import('../../../../application/output-knowledge/src/private/PrivateAcquisitionCoordinator.js')
  const { chain, context, resolver } =
    await import('../../../../application/output-knowledge/test/evidence-fixture.js')
  const selected = { ...chain, network: 'mock' as const }
  let wallet!: Awaited<ReturnType<typeof acquisitionNativeWalletFixture>>
  let coordinator!: InstanceType<typeof PrivateAcquisitionCoordinator>
  const f = await clientFixture(
    async owner => {
      const view = await resolver.resolve(
        { ...context().view, chain: selected },
        new AbortController().signal
      )
      wallet = await acquisitionNativeWalletFixture(selected, view.tracker)
      coordinator = new PrivateAcquisitionCoordinator({
        ...owner.options,
        wallet: wallet.native.bridge
      })
      return { service: coordinator }
    },
    false,
    selected
  )
  try {
    const quote = await new OutputPaidLookupTransport({ ...f.common, operation: 'quote' }).send()
    if (quote.kind !== 'challenge') throw new Error('Expected retained quote')
    f.loseReply()
    await expect(
      new OutputPaidLookupTransport({
        ...f.common,
        operation: 'pay',
        challenge: quote.challenge,
        payment: f.payment
      }).send()
    ).rejects.toThrow('lost authenticated')
    for (let retry = 0; retry < 2; retry++) {
      const result = await new OutputPaidLookupTransport({
        ...f.common,
        operation: 'recover',
        challenge: quote.challenge
      }).send()
      expect(result).toMatchObject({ status: 'delivered', result: { context: 'AQID' } })
    }
    const outputs = await wallet.native.active.findOutputs({
      partial: { txid: f.paymentTransaction.id('hex') }
    })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      satoshis: 100,
      vout: 0,
      change: true,
      senderIdentityKey: f.caller.buyer
    })
    const transactions = await wallet.native.active.findTransactions({
      partial: { txid: f.paymentTransaction.id('hex') }
    })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].satoshis).toBe(100)
    expect(wallet.broadcast).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.requests.filter(request => request.headers.has('x-bsv-payment'))).toHaveLength(1)
  } finally {
    await coordinator.stop()
    await f.close()
    await wallet.close()
  }
}, 30000)
it('carries the explicit bounded payment envelope without inheriting automatic payment', async () => {
  const f = await clientFixture()
  try {
    const quote = await new OutputPaidLookupTransport({ ...f.common, operation: 'quote' }).send()
    if (quote.kind !== 'challenge') throw new Error('Expected retained quote')
    // Exact representation ceiling, deliberately not valid transaction evidence.
    // Transport must carry it; the service independently rejects its contents.
    const payment = { ...f.payment, transaction: Buffer.alloc(65536).toString('base64') }
    await expect(
      new OutputPaidLookupTransport({
        ...f.common,
        operation: 'pay',
        challenge: quote.challenge,
        payment
      }).send()
    ).rejects.toMatchObject({ code: 'invalid' })
    const paid = f.requests.filter(request => request.headers.has('x-bsv-payment'))
    expect(paid).toHaveLength(1)
    expect(Buffer.byteLength(paid[0].headers.get('x-bsv-payment')!)).toBeGreaterThan(87000)
    const corrected = await new OutputPaidLookupTransport({
      ...f.common,
      operation: 'pay',
      challenge: quote.challenge,
      payment: f.payment
    }).send()
    expect(corrected).toMatchObject({ status: 'delivered', challenge: quote.challenge })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.getCredits()).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
