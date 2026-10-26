import { describe, expect, it, jest } from '@jest/globals'
import {
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  type AtomicBEEF,
  type CreateActionArgs,
  type WalletInterface
} from '@bsv/sdk'
import {
  LCHHttpServer,
  LCHHttpAcquisitionClient,
  LCHBuyer,
  LCHIssuer,
  LCHMultipayBuyer,
  LCHPayee,
  LCHQuoteIssuer,
  LCHSettlementService,
  LCH_LIMITS,
  LCH_SETTLEMENT_PROFILES,
  LCH_TRANSACTION_EVIDENCE_POLICIES,
  BRC29_PAYMENT_PROTOCOL,
  WalletAuthorizedOutputPayee,
  WalletBRC77Signer,
  objectId,
  sha256,
  signObject,
  toBase64Url,
  toHex,
  validateLicenseRequest,
  type PaymentCompletion,
  type LCHAcquisitionTransport,
  type LCHValue,
  type SignedObject
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('recovery-safe multipay buyer', () => {
  it('preflights, funds once, delivers every output, completes, and recovers the License', async () => {
    const buyerWallet = actionWallet(121)
    const issuerSigner = await walletSigner(122)
    const payees = await Promise.all(
      [
        {
          key: 123,
          satoshis: 7,
          dutyUid: 'urn:lch:duty:recording',
          endpoint: 'https://drummer.test/payments'
        },
        {
          key: 124,
          satoshis: 5,
          dutyUid: 'urn:lch:duty:composition',
          endpoint: 'https://composer.test/payments'
        }
      ].map(async item => ({
        ...item,
        signer: await walletSigner(item.key)
      }))
    )
    const endpoint = 'https://issuer.test/licenses'
    const assetId = bytes(2, 32)
    const acceptedPolicy = await policyReference('accepted offer policy')
    const offer = await testOffer(issuerSigner, assetId, endpoint, acceptedPolicy)
    const offerId = await objectId('offer', offer.body)
    const demands = new Map<string, { demand: SignedObject; payee: (typeof payees)[number] }>()
    let issuedLicense: SignedObject | undefined
    let mutateLicense: ((body: Record<string, LCHValue>) => void) | undefined
    const server = new LCHHttpServer({
      handlers: {
        preflightLicense: async request => {
          await validateLicenseRequest(request)
        },
        quote: async request => {
          const requestId = await validateLicenseRequest(request)
          const buyerIdentity = request.body.buyer as Uint8Array
          const signedDemands = await Promise.all(
            payees.map(async payee => {
              const demand = await new LCHPayee(payee.signer).createDemand({
                requestId,
                offerId,
                dutyUid: payee.dutyUid,
                buyer: buyerIdentity,
                endpoint: payee.endpoint,
                satoshis: payee.satoshis,
                expiresAt: 2_000,
                recoveryPeriodSeconds: 86_400
              })
              demands.set(toHex(await objectId('payment-demand', demand.body)), { demand, payee })
              return demand
            })
          )
          return new LCHQuoteIssuer(issuerSigner).createQuote({
            requestId,
            offerId,
            assetId,
            buyer: buyerIdentity,
            selection: { type: 'all' },
            demands: signedDemands,
            expiresAt: 2_000,
            recoveryPeriodSeconds: 86_400
          })
        },
        complete: async (completion: PaymentCompletion) => {
          const requestId = await objectId('license-request', completion.request.body)
          const body: Record<string, LCHValue> = {
            version: 1,
            assetId,
            offerId,
            requestId,
            issuer: issuerSigner.identityKey,
            subject: completion.request.body.buyer!,
            issuedAt: 1_100,
            agreement: await policyReference('buyer agreement'),
            selection: completion.request.body.selection!,
            fulfillments: await Promise.all(
              completion.receipts.map(async receipt => {
                const demandId = receipt.body.demandId as Uint8Array
                const demand = demands.get(toHex(demandId))!.demand
                return {
                  dutyUid: demand.body.dutyUid!,
                  settlementProfile: demand.body.settlementProfile!,
                  receiptIds: [await objectId('payment-receipt', receipt.body)]
                }
              })
            ),
            keyGrants: []
          }
          mutateLicense?.(body)
          issuedLicense = await signObject('license', body, issuerSigner)
          return issuedLicense
        },
        recover: async () => issuedLicense
      }
    })
    const payeeServers = new Map(
      payees.map(
        payee =>
          [
            payee.endpoint,
            new LCHHttpServer({
              handlers: {
                preflightDemand: async demand => {
                  const demandId = await objectId('payment-demand', demand.body)
                  if (demands.get(toHex(demandId))?.payee !== payee)
                    throw new Error('unknown Demand')
                  return new LCHPayee(payee.signer).createReadiness({
                    demandId,
                    requestId: demand.body.requestId as Uint8Array,
                    buyer: demand.body.buyer as Uint8Array,
                    issuedAt: 1_000,
                    readyUntil: 1_100,
                    recoveryUntil: demand.body.recoveryUntil as number | bigint
                  })
                },
                paymentDelivery: async delivery => {
                  const demandId = delivery.body.demandId as Uint8Array
                  const runtime = demands.get(toHex(demandId))
                  if (runtime?.payee !== payee) throw new Error('unknown Demand')
                  const transaction = Transaction.fromAtomicBEEF(
                    delivery.body.atomicBeef as AtomicBEEF
                  )
                  return new LCHPayee(payee.signer).createReceipt({
                    demandId,
                    requestId: delivery.body.requestId as Uint8Array,
                    txid: Uint8Array.from(transaction.id('array')),
                    outputIndex: delivery.body.outputIndex as number,
                    satoshis: payee.satoshis,
                    receivedAt: 1_100
                  })
                }
              }
            })
          ] as const
      )
    )
    const routedHttp = new LCHHttpAcquisitionClient({
      endpointPolicy: {
        allowLocalOrigins: ['https://issuer.test', 'https://drummer.test', 'https://composer.test'],
        connect: async (url, init) => {
          const destinationUrl = url.toString()
          const destination =
            destinationUrl === endpoint ? server : payeeServers.get(destinationUrl)
          if (destination === undefined) throw new Error(`unknown destination ${url}`)
          return destination.handle(new Request(url, init))
        }
      }
    })
    const buyer = new LCHMultipayBuyer(buyerWallet.wallet, await walletSigner(121), {
      now: () => 1_000n,
      transport: routedHttp,
      agreementEvaluator: ({ agreement }) =>
        agreement.inline !== undefined &&
        new TextDecoder().decode(agreement.inline) === 'buyer agreement'
    })
    const request = await buyer.createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: acceptedPolicy.digest as Uint8Array,
      createdAt: 1_000
    })
    const plan = await buyer.quote(offer, request, issuerSigner.identityKey, { type: 'none' })
    expect(plan.totalSatoshis).toBe(12n)
    expect(plan.readiness).toHaveLength(2)

    await expect(
      buyer.createPayment({ ...plan, totalSatoshis: plan.totalSatoshis - 1n })
    ).rejects.toThrow(/totals or deadlines do not match/u)
    expect(buyerWallet.createdActions()).toBe(0)

    const payment = await buyer.createPayment(plan)
    expect(buyerWallet.createdActions()).toBe(1)
    expect(payment.deliveries).toHaveLength(2)
    expect(payment.deliveries.map(item => item.endpoint)).toEqual(
      payees.map(payee => payee.endpoint)
    )
    const receipts = await Promise.all(
      payment.deliveries.map(delivery => buyer.deliver(payment, delivery))
    )
    const license = await buyer.complete(payment, receipts)
    await expect(buyer.recover(payment, receipts)).resolves.toEqual(license)

    mutateLicense = body => {
      body.assetId = bytes(9, 32)
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/License Asset ID/u)
    await expect(buyer.recover(payment, receipts)).rejects.toThrow(/License Asset ID/u)
    mutateLicense = body => {
      body.selection = { type: 'segments', ranges: [[0, 1]] }
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/License Selection/u)
    mutateLicense = body => {
      body.agreement = {
        mediaType: 'application/ld+json',
        digest: bytes(99, 32),
        inline: new TextEncoder().encode('substituted agreement')
      }
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/digest mismatch/u)
    const weakenedAgreement = await policyReference('weakened agreement')
    mutateLicense = body => {
      body.agreement = weakenedAgreement
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/configured policy evaluator/u)
    mutateLicense = body => {
      body.fulfillments = []
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/fulfillments do not match/u)
    mutateLicense = body => {
      body.keyGrants = [
        { keyId: bytes(8, 32), delivery: 'https://example.test/key', payload: bytes(7, 1) }
      ]
    }
    await expect(buyer.complete(payment, receipts)).rejects.toThrow(/unexpected key grants/u)
    mutateLicense = undefined
    await expect(buyer.complete(payment, receipts.slice(1))).rejects.toThrow(
      /one Receipt per Delivery/u
    )
    await expect(buyer.complete(payment, [receipts[0]!, receipts[0]!])).rejects.toThrow(
      /unexpected or repeated Receipt/u
    )
    expect(buyerWallet.createdActions()).toBe(1)
  })

  it('rejects endpoint-only quote calls at compile-time and at the JavaScript boundary', async () => {
    const signer = await walletSigner(129)
    const quote = jest.fn(async () => ({ body: {}, signatures: [] }))
    const buyer = new LCHMultipayBuyer(actionWallet(130).wallet, signer, {
      transport: {
        preflightLicense: async () => undefined,
        quote,
        preflightDemand: async demand => demand,
        authorizePayment: async demand => demand,
        deliver: async delivery => delivery,
        storeDelivery: async (_endpoint, _authorization, delivery) => delivery,
        attestTransaction: async (_endpoint, authorization) => authorization,
        complete: async completion => completion.request,
        recover: async () => undefined
      }
    })
    const request = await signObject('license-request', { version: 1 }, signer)

    // @ts-expect-error The 0.1 endpoint-only overload was removed in 0.2.
    const legacyEndpoint: Parameters<LCHMultipayBuyer['quote']>[0] =
      'https://legacy.example/license'
    expect(legacyEndpoint).toBe('https://legacy.example/license')
    const untypedQuote = buyer.quote as unknown as (
      endpoint: string,
      request: SignedObject,
      issuer: Uint8Array,
      keyGrants: { type: 'none' }
    ) => Promise<unknown>
    await expect(
      untypedQuote('https://legacy.example/license', request, signer.identityKey, { type: 'none' })
    ).rejects.toThrow('signed Offer is required')
    expect(quote).not.toHaveBeenCalled()
  })

  it('refuses to fund at the signed Quote expiry boundary', async () => {
    const signer = await walletSigner(131)
    const buyer = new LCHMultipayBuyer(actionWallet(132).wallet, signer, {
      now: () => 2_000n,
      agreementEvaluator: () => true
    })
    await expect(
      buyer.createPayment({
        offer: await signObject('offer', { version: 1 }, signer),
        seller: signer.identityKey,
        request: await signObject('license-request', { version: 1 }, signer),
        requestId: bytes(1, 32),
        quote: await signObject('quote', { version: 1 }, signer),
        demands: [],
        readiness: [],
        authorizations: [],
        issuer: signer.identityKey,
        endpoint: 'https://multipay.test/lch',
        totalSatoshis: 0n,
        expiresAt: 2_000n,
        recoveryUntil: 3_000n,
        keyGrants: { type: 'none' as const }
      })
    ).rejects.toThrow(/expired before transaction creation/u)
  })

  it('rejects independently returned Receipts that do not match the funded plan', async () => {
    const buyerSigner = await walletSigner(141)
    const payeeSigner = await walletSigner(142)
    const assetId = bytes(3, 32)
    const endpoint = 'https://issuer.test/licenses'
    const acceptedPolicy = await policyReference('receipt validation policy')
    const offer = await testOffer(buyerSigner, assetId, endpoint, acceptedPolicy)
    const offerId = await objectId('offer', offer.body)
    const request = await new LCHBuyer(buyerSigner).createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: acceptedPolicy.digest as Uint8Array,
      createdAt: 1_000
    })
    const requestId = await objectId('license-request', request.body)
    const demand = await new LCHPayee(payeeSigner).createDemand({
      requestId,
      offerId,
      dutyUid: 'urn:lch:duty:distributed',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://drummer.test/payments',
      satoshis: 7,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const demandId = await objectId('payment-demand', demand.body)
    const suffix = bytes(3, 32)
    const fundingWallet = actionWallet(141)
    const derived = await fundingWallet.wallet.getPublicKey({
      protocolID: [...BRC29_PAYMENT_PROTOCOL],
      keyID: `${toBase64Url(demand.body.derivationPrefix as Uint8Array)} ${toBase64Url(suffix)}`,
      counterparty: toHex(payeeSigner.identityKey)
    })
    const transaction = new Transaction(
      1,
      [],
      [
        {
          satoshis: 7,
          lockingScript: new P2PKH().lock(PublicKey.fromString(derived.publicKey).toAddress())
        }
      ]
    )
    const atomicBeef = Uint8Array.from(transaction.toAtomicBEEF(true))
    const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
      demandId,
      requestId,
      atomicBeef,
      outputIndex: 0,
      derivationPrefix: demand.body.derivationPrefix as Uint8Array,
      derivationSuffix: suffix
    })
    let receiptDemandId = demandId
    let receiptRequestId = requestId
    let receiptOutputIndex = 1
    let receiptSatoshis = 7
    const deliver = jest.fn(async () =>
      new LCHPayee(payeeSigner).createReceipt({
        demandId: receiptDemandId,
        requestId: receiptRequestId,
        txid: Uint8Array.from(transaction.id('array')),
        outputIndex: receiptOutputIndex,
        satoshis: receiptSatoshis,
        receivedAt: 1_100
      })
    )
    const transport: LCHAcquisitionTransport = {
      preflightLicense: async () => undefined,
      quote: async () => {
        throw new Error('unused')
      },
      preflightDemand: async () => demand,
      authorizePayment: async () => {
        throw new Error('unused')
      },
      deliver,
      complete: async () => {
        throw new Error('unused')
      },
      storeDelivery: async () => {
        throw new Error('unused')
      },
      attestTransaction: async () => {
        throw new Error('unused')
      },
      recoverUnverified: async () => undefined
    }
    const quote = await new LCHQuoteIssuer(buyerSigner).createQuote({
      requestId,
      offerId,
      assetId,
      buyer: buyerSigner.identityKey,
      selection: { type: 'all' },
      demands: [demand],
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const funded = {
      plan: {
        offer,
        seller: buyerSigner.identityKey,
        request,
        requestId,
        quote,
        demands: [demand],
        readiness: [],
        authorizations: [],
        issuer: buyerSigner.identityKey,
        endpoint,
        totalSatoshis: 7n,
        expiresAt: 2_000n,
        recoveryUntil: 88_400n,
        keyGrants: { type: 'none' as const }
      },
      atomicBeef,
      transactionState: 'finalized' as const,
      deliveries: [
        {
          demandId,
          payee: payeeSigner.identityKey,
          endpoint: 'https://drummer.test/payments',
          delivery
        }
      ]
    }
    const buyer = new LCHMultipayBuyer(fundingWallet.wallet, buyerSigner, {
      transport,
      agreementEvaluator: () => true
    })
    await expect(
      buyer.deliver(
        { ...funded, atomicBeef: new Uint8Array(LCH_LIMITS.headerBytes + 1) },
        funded.deliveries[0]!
      )
    ).rejects.toThrow(/byte-string limit exceeded/u)
    expect(deliver).not.toHaveBeenCalled()
    await expect(buyer.deliver(funded, funded.deliveries[0]!)).rejects.toThrow(
      /output index does not match/u
    )
    receiptOutputIndex = 0
    receiptSatoshis = 8
    await expect(buyer.deliver(funded, funded.deliveries[0]!)).rejects.toThrow(
      /amount does not match/u
    )
    receiptSatoshis = 7
    receiptDemandId = bytes(9, 32)
    const unknownDelivery = { ...funded.deliveries[0]!, demandId: receiptDemandId }
    await expect(buyer.deliver(funded, unknownDelivery)).rejects.toThrow(
      /not part of the funded payment/u
    )
    receiptDemandId = demandId
    receiptRequestId = bytes(8, 32)
    const wrongRequestReceipt = await transport.deliver('', delivery)
    await expect(buyer.complete(funded, [wrongRequestReceipt])).rejects.toThrow(
      /Receipt Request ID does not match/u
    )
  })

  it('falls back to authorized-output evidence when a Payee goes offline', async () => {
    const buyerSigner = await walletSigner(151)
    const payeeWallet = new ProtoWallet(new PrivateKey(152))
    const payeeSigner = await WalletBRC77Signer.create({ wallet: payeeWallet })
    const providerSigner = await walletSigner(153)
    const issuerSigner = await walletSigner(154)
    const assetId = bytes(2, 32)
    const endpoint = 'https://issuer.test/licenses'
    const acceptedPolicy = await policyReference('authorized output policy')
    const offer = await testOffer(issuerSigner, assetId, endpoint, acceptedPolicy)
    const offerId = await objectId('offer', offer.body)
    const request = await new LCHBuyer(buyerSigner).createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: acceptedPolicy.digest as Uint8Array,
      createdAt: 1_000
    })
    const requestId = await objectId('license-request', request.body)
    const demand = await new LCHPayee(payeeSigner).createDemand({
      requestId,
      offerId,
      dutyUid: 'urn:lch:duty:offline-drummer',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://drummer.test/payments',
      satoshis: 7,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400,
      settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput
    })
    const demandId = await objectId('payment-demand', demand.body)
    const authorization = await new WalletAuthorizedOutputPayee({
      wallet: payeeWallet,
      signer: payeeSigner,
      now: () => 1_000n,
      random: length => bytes(4, length)
    }).authorize(demand, {
      evidenceProvider: providerSigner.identityKey,
      evidenceEndpoint: 'https://processor.test/evidence',
      deliveryProvider: providerSigner.identityKey,
      deliveryEndpoint: 'https://availability.test/store',
      retrievalEndpoint: 'https://availability.test/retrieve'
    })
    const transaction = new Transaction(
      1,
      [],
      [
        {
          satoshis: 7,
          lockingScript: LockingScript.fromHex(
            toHex(authorization.body.lockingScript as Uint8Array)
          )
        }
      ]
    )
    const atomicBeef = Uint8Array.from(transaction.toAtomicBEEF(true))
    const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
      demandId,
      requestId,
      atomicBeef,
      outputIndex: 0,
      derivationPrefix: authorization.body.derivationPrefix as Uint8Array,
      derivationSuffix: authorization.body.derivationSuffix as Uint8Array
    })
    const authorizationId = await objectId('payment-authorization', authorization.body)
    const service = new LCHSettlementService(providerSigner)
    const acknowledgement = await service.createDeliveryAcknowledgement({
      authorizationId,
      deliveryId: await objectId('payment-delivery', delivery.body),
      demandId,
      requestId,
      payee: payeeSigner.identityKey,
      storedAt: 1_050,
      availableUntil: 88_400,
      retrievalEndpoint: 'https://availability.test/retrieve'
    })
    const evidence = await service.createTransactionEvidence({
      authorizationId,
      txid: Uint8Array.from(transaction.id('array')),
      state: 'accepted',
      policy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
      observedAt: 1_050
    })
    const quote = await new LCHQuoteIssuer(issuerSigner).createQuote({
      requestId,
      offerId,
      assetId,
      buyer: buyerSigner.identityKey,
      selection: { type: 'all' },
      demands: [demand],
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    let payeeOnline = false
    let malformedReceipt = false
    let fallbackCalls = 0
    const transport: LCHAcquisitionTransport = {
      preflightLicense: async () => undefined,
      quote: async () => quote,
      preflightDemand: async () => demand,
      authorizePayment: async () => authorization,
      deliver: async () => {
        if (!payeeOnline) throw new Error('Payee is offline')
        return new LCHPayee(payeeSigner).createReceipt({
          demandId,
          requestId,
          txid: Uint8Array.from(transaction.id('array')),
          outputIndex: malformedReceipt ? 1 : 0,
          satoshis: 7,
          receivedAt: 1_050
        })
      },
      storeDelivery: async (endpoint, storedAuthorization, storedDelivery) => {
        fallbackCalls += 1
        expect(endpoint).toBe('https://availability.test/store')
        expect(storedAuthorization).toEqual(authorization)
        expect(storedDelivery).toEqual(delivery)
        return acknowledgement
      },
      attestTransaction: async (endpoint, attestedAuthorization, beef) => {
        expect(endpoint).toBe('https://processor.test/evidence')
        expect(attestedAuthorization).toEqual(authorization)
        expect(beef).toEqual(atomicBeef)
        return evidence
      },
      complete: async (_endpoint, completion) => {
        expect(completion.receipts).toHaveLength(0)
        expect(completion.authorizedOutputs).toHaveLength(1)
        const bundle = completion.authorizedOutputs![0]!
        return signObject(
          'license',
          {
            version: 1,
            assetId,
            offerId,
            requestId,
            issuer: issuerSigner.identityKey,
            subject: buyerSigner.identityKey,
            issuedAt: 1_100,
            agreement: await policyReference('authorized-output agreement'),
            selection: request.body.selection!,
            fulfillments: [
              {
                dutyUid: demand.body.dutyUid!,
                settlementProfile: demand.body.settlementProfile!,
                authorizationId: await objectId('payment-authorization', bundle.authorization.body),
                transactionEvidenceId: await objectId(
                  'transaction-evidence',
                  bundle.transactionEvidence.body
                ),
                deliveryAcknowledgementId: await objectId(
                  'payment-delivery-ack',
                  bundle.deliveryAcknowledgement.body
                )
              }
            ],
            keyGrants: []
          },
          issuerSigner
        )
      },
      recoverUnverified: async () => undefined
    }
    const item = {
      demandId,
      payee: payeeSigner.identityKey,
      endpoint: 'https://drummer.test/payments',
      delivery
    }
    const funded = {
      plan: {
        offer,
        seller: issuerSigner.identityKey,
        request,
        requestId,
        quote,
        demands: [demand],
        readiness: [],
        authorizations: [authorization],
        issuer: issuerSigner.identityKey,
        endpoint,
        totalSatoshis: 7n,
        expiresAt: 2_000n,
        recoveryUntil: 88_400n,
        keyGrants: { type: 'none' as const }
      },
      atomicBeef,
      transactionState: 'finalized' as const,
      deliveries: [item]
    }
    const buyer = new LCHMultipayBuyer(actionWallet(151).wallet, buyerSigner, {
      transport,
      agreementEvaluator: () => true
    })
    const offlineSettlement = await buyer.settleDelivery(funded, item)
    expect(offlineSettlement.type).toBe('authorized-output')
    expect(fallbackCalls).toBe(1)
    if (offlineSettlement.type !== 'authorized-output') throw new Error('unexpected settlement')
    await expect(buyer.complete(funded, [], [offlineSettlement.evidence])).resolves.toMatchObject({
      body: { requestId, subject: buyerSigner.identityKey }
    })

    payeeOnline = true
    malformedReceipt = true
    await expect(buyer.settleDelivery(funded, item)).rejects.toThrow(/output index does not match/u)
    expect(fallbackCalls).toBe(1)
    malformedReceipt = false
    await expect(buyer.settleDelivery(funded, item)).resolves.toMatchObject({ type: 'receipt' })
  })
})

async function walletSigner(privateKey: number): Promise<WalletBRC77Signer> {
  return WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(privateKey)) })
}

async function policyReference(label: string): Promise<Record<string, LCHValue>> {
  const inline = new TextEncoder().encode(label)
  return { mediaType: 'application/ld+json', digest: await sha256(inline), inline }
}

async function testOffer(
  signer: WalletBRC77Signer,
  assetId: Uint8Array,
  endpoint: string,
  policy: Record<string, LCHValue>
): Promise<SignedObject> {
  return new LCHIssuer(signer).createOffer({
    assetId,
    usageProfile: 'https://example.test/lch/profile',
    seller: signer.identityKey,
    licenseIssuer: signer.identityKey,
    requiredInterests: ['licensed-work'],
    policy,
    payment: {
      protocol: 'https://example.test/lch/payment',
      endpoint,
      asset: 'BSV',
      unit: 'satoshi',
      recoveryPeriodSeconds: 86_400,
      pricing: { kind: 'quote' }
    },
    keyDelivery: { mechanism: 'https://example.test/lch/key-delivery' },
    enforcement: { class: 'https://example.test/lch/enforcement' },
    notBefore: 0,
    nonce: bytes(6, 16)
  })
}

function actionWallet(privateKey: number): {
  wallet: WalletInterface
  createdActions(): number
} {
  const proto = new ProtoWallet(new PrivateKey(privateKey))
  let actions = 0
  const wallet = new Proxy(proto as unknown as WalletInterface, {
    get(target, property, receiver) {
      if (property === 'createAction')
        return async (args: CreateActionArgs) => {
          actions += 1
          const outputs = (args.outputs ?? [])
            .map(output => ({
              satoshis: output.satoshis,
              lockingScript: LockingScript.fromHex(output.lockingScript)
            }))
            .reverse()
          const transaction = new Transaction(1, [], outputs)
          return { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF(true) }
        }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { wallet, createdActions: () => actions }
}
