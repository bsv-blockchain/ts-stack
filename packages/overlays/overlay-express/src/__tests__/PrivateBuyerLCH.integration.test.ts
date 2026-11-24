import { expect, it } from '@jest/globals'
import {
  CompletedProtoWallet,
  PrivateKey,
  retainOutputCapability,
  canonicalOutputJSON,
  type OutputCapabilityRequest
} from '@bsv/sdk'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'
import { buyerFixture } from '../../../../application/output-knowledge/test/private-lookup-buyer.fixture.js'
import { nativeBuyerFixture } from '../../../../application/output-knowledge/test/private-buyer-native.fixture.js'
import { acquisitionNativeWalletFixture } from '../../../../application/output-knowledge/test/private-acquisition-wallet.fixture.js'
import { PrivateAcquisitionCoordinator } from '../../../../application/output-knowledge/src/private/PrivateAcquisitionCoordinator.js'
import { SDKPrivateAcquisitionFunding } from '../../../../application/output-knowledge/src/private/SDKPrivateAcquisitionFunding.js'
import {
  context,
  resolver
} from '../../../../application/output-knowledge/test/evidence-fixture.js'
import { lchPaidFixture } from '../../../../content/lch/test/overlay-acquisition-paid.fixture.js'
import { LCHOverlayPaidSeller } from '../../../../content/lch/src/overlayAcquisitionSeller.js'
import { LCHOverlayPaidDomain } from '../../../../content/lch/src/overlayAcquisitionPaid.js'

it('recovers an authenticated LCH purchase after losing the paid reply and reopening native buyer custody, then plays the actual encrypted Asset without another charge', async () => {
  const buyerWallet = await nativeBuyerFixture(),
    signal = new AbortController().signal,
    view = await resolver.resolve({ ...context().view, chain: buyerWallet.selected }, signal),
    sellerWallet = await acquisitionNativeWalletFixture(buyerWallet.selected, view.tracker)
  let seller!: PrivateAcquisitionCoordinator,
    lch!: Awaited<ReturnType<typeof lchPaidFixture>>,
    catalogue = true
  const host = await privateAcquisitionHTTPFixture(
    async owner => {
      const installation = owner.options.contracts.configuration()
      lch = await lchPaidFixture(buyerWallet.selected, {
        baseURL: installation.baseURL,
        service: installation.service,
        rules: { id: 'urn:test:acquisition-record-rules', parameters: { version: 1 } },
        maximumRequestBytes: installation.maximumRequestBytes,
        maximumResponseBytes: installation.maximumResponseBytes
      })
      const funding = new SDKPrivateAcquisitionFunding(resolver, lch.sellerWallet, () => ({
          ...context(),
          view: { ...context().view, chain: buyerWallet.selected }
        })),
        domain = new LCHOverlayPaidSeller({
          id: 'urn:reference:native-http-lch-seller:1',
          catalogue: {
            load: () =>
              catalogue
                ? Promise.resolve({
                    header: lch.input.header,
                    offer: lch.offer,
                    evidence: lch.delivered.result!.evidence,
                    verificationContext: {
                      ...context(),
                      view: { ...context().view, chain: buyerWallet.selected }
                    },
                    keys: [...lch.asset.keys].map(([id, cek]) => ({
                      keyId: Uint8Array.from(Buffer.from(id, 'hex')),
                      cek
                    }))
                  })
                : Promise.reject(new Error('Catalogue withdrawn'))
          },
          source: lch.storage,
          sellerSigner: lch.seller,
          issuerSigner: lch.seller,
          issuerWallet: lch.sellerWallet,
          verification: {
            ...lch.options.verification,
            funding: (...args) => funding.verify(...args)
          },
          async credited(operation, operationId, active) {
            expect(active.aborted).toBe(false)
            expect(operationId).toBe(operation.id)
            // Read the actual durable native credit record; the coordinator's saved
            // receipt is insufficient by itself. This port never internalizes again.
            const outcome = await sellerWallet.native.controller.getInternalization(operationId)
            expect(outcome.state).toBe('accepted')
            if (outcome.state !== 'accepted') throw new Error('Native credit unresolved')
            expect(canonicalOutputJSON(outcome.funding)).toBe(
              canonicalOutputJSON(operation.funding)
            )
            expect(outcome.receipt).toMatchObject({
              operationId,
              funding: operation.funding,
              satoshis: operation.satoshis,
              walletIdentity: sellerWallet.native.identities.wallet,
              storageIdentity: sellerWallet.native.identities.storage
            })
            expect(outcome.receipt.transactionId).toBeGreaterThan(0)
          },
          authorityNetwork: 'testnet',
          maximumCiphertextBytes: 1048576,
          quoteSeconds: '80',
          derivationPrefix: () => Buffer.alloc(32, 13).toString('base64'),
          clock: lch.options.clock,
          current: lch.options.current
        })
      seller = new PrivateAcquisitionCoordinator({
        ...owner.options,
        domain,
        wallet: sellerWallet.native.bridge,
        manifest: () => lch.selection.manifest
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
    contract = retainOutputCapability(lch.selection.manifest, trust).record,
    payments: string[] = [],
    requests: string[] = []
  let lose = true,
    activeDomain = lch.domain,
    activePayment = buyerWallet.payment
  const wire: typeof fetch = async (input, init) => {
    const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      ),
      payment = new Headers(init?.headers).get('x-bsv-payment')
    if (url.origin !== new URL(installation.baseURL).origin) throw new Error('Unexpected seller')
    requests.push(url.pathname)
    if (payment) payments.push(payment)
    // Mutual BRC-103 authentication over isolated HTTP; TLS is outside this test.
    const response = await fetch(host.origin + url.pathname, init),
      body = await response.arrayBuffer()
    if (payment && lose) {
      lose = false
      throw new Error('Lost LCH paid reply after commit')
    }
    return new Response(body, { status: response.status, headers: response.headers })
  }
  const f = await buyerFixture({
    original: { contract, request: lch.acquire, derivationSuffix: 'bmF0aXZlLWxjaC1idXllcg==' },
    trust,
    wallet: new CompletedProtoWallet(new PrivateKey(84)),
    payment: {
      configuration: buyerWallet.payment.configuration,
      plan: (...args) => activePayment.plan(...args),
      finish: (...args) => activePayment.finish(...args),
      recover: (...args) => activePayment.recover(...args)
    },
    fetch: wire,
    validation: {
      id: lch.domain.id,
      preflight: (...args) => activeDomain.preflight(...args),
      verify: (...args) => activeDomain.verify(...args),
      usable: (...args) => activeDomain.usable(...args)
    }
  })
  try {
    const owner = await f.open(true)
    await expect(owner.buyer.advance()).rejects.toThrow('Lost LCH paid reply')
    expect(payments).toHaveLength(1)
    const credits = () =>
      sellerWallet.native.active.findOutputs({
        partial: { senderIdentityKey: buyerWallet.native.identities.wallet }
      })
    expect(await credits()).toHaveLength(1)
    expect((await credits())[0].satoshis).toBe(100)
    const original = { id: activeDomain.id, original: activeDomain.original() }
    await owner.buyer.stop()
    await owner.state.close()
    await owner.objects.close()
    await lch.objects.close()
    await buyerWallet.native.close()
    activePayment = (await buyerWallet.reopen()).payment
    catalogue = false
    f.setNow('200')
    host.f.setNow('200')
    lch.setNow('200')
    activeDomain = await LCHOverlayPaidDomain.open(lch.options, original, lch.openObjects())
    const reopened = await f.open(),
      result = await reopened.buyer.recover()
    expect(result?.status).toBe('delivered')
    expect(await reopened.buyer.validate()).toBe('usable')
    expect(await activeDomain.playback(result!, signal)).toEqual(lch.plaintext)
    expect(payments).toHaveLength(1)
    expect(requests.at(-1)).toBe('/api/overlay/v1/private/recover')
    expect(await credits()).toHaveLength(1)
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
