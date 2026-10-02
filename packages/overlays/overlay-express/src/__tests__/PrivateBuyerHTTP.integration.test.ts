import { expect, it } from '@jest/globals'
import {
  CompletedProtoWallet,
  PrivateKey,
  ProtoWallet,
  retainOutputCapability,
  type OutputCapabilityRequest
} from '@bsv/sdk'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'
import { buyerFixture } from '../../../../application/output-knowledge/test/private-lookup-buyer.fixture.js'
import { nativeBuyerFixture } from '../../../../application/output-knowledge/test/private-buyer-native.fixture.js'
import { acquisitionNativeWalletFixture } from '../../../../application/output-knowledge/test/private-acquisition-wallet.fixture.js'
import { PrivateAcquisitionCoordinator } from '../../../../application/output-knowledge/src/private/PrivateAcquisitionCoordinator.js'
import { SDKPrivateAcquisitionFunding } from '../../../../application/output-knowledge/src/private/SDKPrivateAcquisitionFunding.js'
import { SDKEvidenceVerifier } from '../../../../application/output-knowledge/src/SDKEvidenceVerifier.js'
import { Hash, Utils } from '@bsv/sdk'
import {
  context,
  resolver
} from '../../../../application/output-knowledge/test/evidence-fixture.js'

it('recovers a lost authenticated delivery with one actual buyer action and one actual seller credit, then validates the retained result', async () => {
  const buyerWallet = await nativeBuyerFixture(),
    signal = new AbortController().signal,
    view = await resolver.resolve({ ...context().view, chain: buyerWallet.selected }, signal),
    sellerWallet = await acquisitionNativeWalletFixture(buyerWallet.selected, view.tracker)
  let seller!: PrivateAcquisitionCoordinator
  const host = await privateAcquisitionHTTPFixture(
    async owner => {
      seller = new PrivateAcquisitionCoordinator({
        ...owner.options,
        wallet: sellerWallet.native.bridge
      })
      return { service: seller }
    },
    false,
    buyerWallet.selected
  )
  const installation = host.contract.installation,
    trust: OutputCapabilityRequest = {
      ...host.f.f.trust,
      baseURL: installation.baseURL,
      identity: installation.seller,
      chain: installation.chain,
      service: installation.service,
      profile: host.caller.profile,
      kind: 'lookup',
      now: '20'
    },
    contract = retainOutputCapability(host.f.f.manifest(), trust).record,
    payments: string[] = [],
    requests: string[] = []
  let lose = true
  const wire: typeof fetch = async (input, init) => {
    const selected = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      ),
      headers = new Headers(init?.headers)
    if (selected.origin !== new URL(installation.baseURL).origin)
      throw new Error('Unexpected synthetic seller')
    requests.push(selected.pathname)
    const payment = headers.get('x-bsv-payment')
    if (payment) payments.push(payment)
    // Actual authenticated HTTP on isolated loopback; this does not test TLS.
    const response = await fetch(host.origin + selected.pathname, init),
      bytes = await response.arrayBuffer()
    if (payment && lose) {
      lose = false
      throw new Error('Lost paid delivery after seller commit')
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
  const snapshot = () => ({
      ...context(),
      view: { ...context().view, chain: buyerWallet.selected }
    }),
    funding = new SDKPrivateAcquisitionFunding(
      resolver,
      new ProtoWallet(new PrivateKey(83)),
      snapshot
    ),
    listing = new SDKEvidenceVerifier(resolver)
  const f = await buyerFixture({
    original: { contract, request: host.request, derivationSuffix: host.payment.derivationSuffix },
    trust,
    wallet: new CompletedProtoWallet(new PrivateKey(84)),
    payment: buyerWallet.payment,
    fetch: wire,
    validation: {
      id: 'urn:test:independent-buyer-script-and-material',
      async verify(request, challenge, payment, delivered, active) {
        const paid = await funding.verify(payment, challenge, request.listing.chain, active)
        expect(delivered.funding).toEqual(paid.operation.funding)
        const evidence = delivered.result!.evidence,
          verified = await listing.verify(
            {
              chain: request.listing.chain,
              evidence,
              variantId: Utils.toHex(Hash.sha256(Utils.toArray(evidence.beef, 'base64')))
            },
            snapshot(),
            active
          )
        expect(verified.status).toBe('verified')
        expect(delivered.result!.context).toBe('AQID')
      },
      usable: delivered => Promise.resolve(delivered.result?.context === 'AQID')
    }
  })
  try {
    const owner = await f.open(true)
    await expect(owner.buyer.advance()).rejects.toThrow('Lost paid delivery')
    expect(payments).toHaveLength(1)
    const nativeCredit = await sellerWallet.native.active.findOutputs({
      partial: { senderIdentityKey: buyerWallet.native.identities.wallet }
    })
    expect(nativeCredit).toHaveLength(1)
    expect(nativeCredit[0].satoshis).toBe(100)
    await owner.buyer.stop()
    await owner.state.close()
    await owner.objects.close()
    f.setNow('200')
    host.f.setNow('200')
    const reopened = await f.open(),
      result = await reopened.buyer.recover()
    expect(result?.status).toBe('delivered')
    expect(await reopened.buyer.status()).toBe('received')
    expect(await reopened.buyer.validate()).toBe('usable')
    expect(payments).toHaveLength(1)
    expect(requests.at(-1)).toBe('/api/overlay/v1/private/recover')
    expect(
      await sellerWallet.native.active.findOutputs({
        partial: { senderIdentityKey: buyerWallet.native.identities.wallet }
      })
    ).toHaveLength(1)
    expect(buyerWallet.fixture.broadcast).not.toHaveBeenCalled()
    expect(sellerWallet.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.dispose()
    await seller.stop()
    await host.close()
    await buyerWallet.close()
    await sellerWallet.close()
  }
}, 30000)
