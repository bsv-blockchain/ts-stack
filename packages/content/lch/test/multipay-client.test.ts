import { describe, expect, it } from '@jest/globals'
import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Transaction,
  type AtomicBEEF,
  type CreateActionArgs,
  type WalletInterface
} from '@bsv/sdk'
import {
  LCHHttpServer,
  LCHHttpAcquisitionClient,
  LCHBuyer,
  LCHMultipayBuyer,
  LCHPayee,
  LCHQuoteIssuer,
  LCHSettlementService,
  LCH_SETTLEMENT_PROFILES,
  LCH_TRANSACTION_EVIDENCE_POLICIES,
  WalletAuthorizedOutputPayee,
  WalletBRC77Signer,
  objectId,
  signObject,
  toHex,
  validateLicenseRequest,
  type PaymentCompletion,
  type LCHAcquisitionTransport,
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
    const offerId = bytes(1, 32)
    const assetId = bytes(2, 32)
    const demands = new Map<string, { demand: SignedObject; payee: (typeof payees)[number] }>()
    let issuedLicense: SignedObject | undefined
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
          issuedLicense = await signObject(
            'license',
            {
              version: 1,
              requestId: await objectId('license-request', completion.request.body),
              subject: completion.request.body.buyer!
            },
            issuerSigner
          )
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
      transport: routedHttp
    })
    const request = await buyer.createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
      createdAt: 1_000
    })
    const plan = await buyer.quote(endpoint, request, issuerSigner.identityKey)
    expect(plan.totalSatoshis).toBe(12n)
    expect(plan.readiness).toHaveLength(2)

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
    await expect(buyer.recover(endpoint, plan.requestId)).resolves.toEqual(license)
    await expect(buyer.complete(payment, receipts.slice(1))).rejects.toThrow(
      /one Receipt per Delivery/u
    )
    await expect(buyer.complete(payment, [receipts[0]!, receipts[0]!])).rejects.toThrow(
      /unexpected or repeated Receipt/u
    )
    expect(buyerWallet.createdActions()).toBe(1)
  })

  it('refuses to fund at the signed Quote expiry boundary', async () => {
    const signer = await walletSigner(131)
    const buyer = new LCHMultipayBuyer(actionWallet(132).wallet, signer, {
      now: () => 2_000n
    })
    await expect(
      buyer.createPayment({
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
        recoveryUntil: 3_000n
      })
    ).rejects.toThrow(/expired before transaction creation/u)
  })

  it('rejects independently returned Receipts that do not match the funded plan', async () => {
    const buyerSigner = await walletSigner(141)
    const payeeSigner = await walletSigner(142)
    const requestId = bytes(1, 32)
    const demand = await new LCHPayee(payeeSigner).createDemand({
      requestId,
      offerId: bytes(2, 32),
      dutyUid: 'urn:lch:duty:distributed',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://drummer.test/payments',
      satoshis: 7,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const demandId = await objectId('payment-demand', demand.body)
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 7, lockingScript: LockingScript.fromHex('51') }]
    )
    const atomicBeef = Uint8Array.from(transaction.toAtomicBEEF(true))
    const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
      demandId,
      requestId,
      atomicBeef,
      outputIndex: 0,
      derivationPrefix: demand.body.derivationPrefix as Uint8Array,
      derivationSuffix: bytes(3, 32)
    })
    let receiptDemandId = demandId
    let receiptRequestId = requestId
    let receiptOutputIndex = 1
    let receiptSatoshis = 7
    const transport: LCHAcquisitionTransport = {
      preflightLicense: async () => undefined,
      quote: async () => {
        throw new Error('unused')
      },
      preflightDemand: async () => demand,
      authorizePayment: async () => {
        throw new Error('unused')
      },
      deliver: async () =>
        new LCHPayee(payeeSigner).createReceipt({
          demandId: receiptDemandId,
          requestId: receiptRequestId,
          txid: Uint8Array.from(transaction.id('array')),
          outputIndex: receiptOutputIndex,
          satoshis: receiptSatoshis,
          receivedAt: 1_100
        }),
      complete: async () => {
        throw new Error('unused')
      },
      storeDelivery: async () => {
        throw new Error('unused')
      },
      attestTransaction: async () => {
        throw new Error('unused')
      },
      recover: async () => undefined
    }
    const request = await signObject(
      'license-request',
      { version: 1, buyer: buyerSigner.identityKey },
      buyerSigner
    )
    const quote = await signObject('quote', { version: 1 }, buyerSigner)
    const funded = {
      plan: {
        request,
        requestId,
        quote,
        demands: [demand],
        readiness: [],
        authorizations: [],
        issuer: buyerSigner.identityKey,
        endpoint: 'https://issuer.test/licenses',
        totalSatoshis: 7n,
        expiresAt: 2_000n,
        recoveryUntil: 88_400n
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
    const buyer = new LCHMultipayBuyer(actionWallet(143).wallet, buyerSigner, { transport })
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
    await expect(buyer.deliver(funded, unknownDelivery)).rejects.toThrow(/unknown Demand/u)
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
    const offerId = bytes(1, 32)
    const assetId = bytes(2, 32)
    const request = await new LCHBuyer(buyerSigner).createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
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
    const quote = await signObject('quote', { version: 1 }, issuerSigner)
    let payeeOnline = false
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
          outputIndex: 0,
          satoshis: 7,
          receivedAt: 1_050
        })
      },
      storeDelivery: async (endpoint, storedAuthorization, storedDelivery) => {
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
        return signObject(
          'license',
          { version: 1, requestId, subject: buyerSigner.identityKey },
          issuerSigner
        )
      },
      recover: async () => undefined
    }
    const item = {
      demandId,
      payee: payeeSigner.identityKey,
      endpoint: 'https://drummer.test/payments',
      delivery
    }
    const funded = {
      plan: {
        request,
        requestId,
        quote,
        demands: [demand],
        readiness: [],
        authorizations: [authorization],
        issuer: issuerSigner.identityKey,
        endpoint: 'https://issuer.test/licenses',
        totalSatoshis: 7n,
        expiresAt: 2_000n,
        recoveryUntil: 88_400n
      },
      atomicBeef,
      transactionState: 'finalized' as const,
      deliveries: [item]
    }
    const buyer = new LCHMultipayBuyer(actionWallet(155).wallet, buyerSigner, { transport })
    const offlineSettlement = await buyer.settleDelivery(funded, item)
    expect(offlineSettlement.type).toBe('authorized-output')
    if (offlineSettlement.type !== 'authorized-output') throw new Error('unexpected settlement')
    await expect(buyer.complete(funded, [], [offlineSettlement.evidence])).resolves.toMatchObject({
      body: { requestId, subject: buyerSigner.identityKey }
    })

    payeeOnline = true
    await expect(buyer.settleDelivery(funded, item)).resolves.toMatchObject({ type: 'receipt' })
  })
})

async function walletSigner(privateKey: number): Promise<WalletBRC77Signer> {
  return WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(privateKey)) })
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
