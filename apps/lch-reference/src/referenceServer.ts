import { Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import {
  LCHHttpServer,
  LCHError,
  LCHIssuer,
  LCHPayee,
  LCHPublisher,
  LCHQuoteIssuer,
  LCHReader,
  LCHSettlementService,
  LCH_MECHANISMS,
  LCH_PROFILES,
  LCH_SETTLEMENT_PROFILES,
  LCH_TRANSACTION_EVIDENCE_POLICIES,
  WalletBRC77Signer,
  WalletAuthorizedOutputPayee,
  WalletBRC78KeyDelivery,
  WalletPaymentReceiver,
  encodeDeterministicCbor,
  objectId,
  sha256,
  toBase64Url,
  toHex,
  validateLicenseRequest,
  validateAuthorizedOutputEvidence,
  validatePaymentAuthorization,
  validatePaymentDelivery,
  validatePaymentDeliveryRetrieval,
  validatePaymentReceipt,
  type AuthorizedOutputEvidence,
  type ContentSink,
  type ContentSource,
  type LCHValue,
  type PaymentCompletion,
  type PaymentDeliveryStoreRequest,
  type ProtectedAsset,
  type SignedObject,
  type StoredPaymentDelivery,
  type TransactionEvidenceRequest
} from '@bsv/lch'

export interface ReferencePayeeOptions {
  wallet: WalletInterface
  satoshis: number
  dutyUid: string
  interest: string
  label: string
  endpoint?: string
  settlementProfile?: string
}

export interface ReferenceLCHServerOptions {
  issuerWallet: WalletInterface
  payees: ReferencePayeeOptions[]
  publicBaseUrl: string
  now?: () => bigint
}

export interface ReferencePublishRequest {
  bytes: Uint8Array
  mediaType: string
  name: string
}

export interface ReferencePublishedAsset {
  assetId: Uint8Array
  offerId: Uint8Array
  lch: Uint8Array
  acquisitionEndpoint: string
}

interface PayeeRuntime extends Omit<ReferencePayeeOptions, 'endpoint'> {
  endpoint: string
  identityKey: Uint8Array
  payee: LCHPayee
  receiver: WalletPaymentReceiver
  authorizer: WalletAuthorizedOutputPayee
  online: boolean
  offlineAfterNextReadiness: boolean
}

interface StoredDelivery {
  authorization: SignedObject
  delivery: SignedObject
  acknowledgement: SignedObject
  payee: PayeeRuntime
}

interface DeliveryClaim {
  authorizationBytes: Uint8Array
  deliveryBytes: Uint8Array
  completion: Promise<SignedObject>
}

interface AssetRecord extends ReferencePublishedAsset {
  protectedAsset: ProtectedAsset
  offer: SignedObject
  policyDigest: Uint8Array
  mediaType: string
  name: string
}

interface QuoteRecord {
  asset: AssetRecord
  request: SignedObject
  quote: SignedObject
  demands: Map<string, { demand: SignedObject; payee: PayeeRuntime }>
}

export class ReferenceContentStore implements ContentSink, ContentSource {
  private readonly values = new Map<string, Uint8Array>()

  constructor(private readonly publicBaseUrl: string) {}

  async put(ciphertext: Uint8Array): Promise<string[]> {
    const key = toHex(await sha256(ciphertext))
    this.values.set(key, ciphertext.slice())
    return [`${this.publicBaseUrl}/content/${key}`]
  }

  async read(locator: string, start = 0n, end?: bigint): Promise<Uint8Array> {
    const key = new URL(locator).pathname.split('/').at(-1)
    const value = key === undefined ? undefined : this.values.get(key)
    if (value === undefined) throw new Error('Reference content is unavailable')
    return value.slice(Number(start), end === undefined ? undefined : Number(end))
  }

  get(key: string): Uint8Array | undefined {
    return this.values.get(key)?.slice()
  }
}

export class ReferenceLCHServer {
  readonly acquisitionEndpoint: string
  readonly evidenceEndpoint: string
  readonly deliveryEndpoint: string
  readonly retrievalEndpoint: string
  readonly payeeEndpoints: ReadonlyArray<{ label: string; endpoint: string }>
  readonly content: ReferenceContentStore
  readonly http: Pick<LCHHttpServer, 'handle'>

  private readonly now: () => bigint
  private readonly issuer: LCHIssuer
  private readonly publisher: LCHPublisher
  private readonly quoteIssuer: LCHQuoteIssuer
  private readonly keyDelivery: WalletBRC78KeyDelivery
  private readonly settlementService: LCHSettlementService
  private readonly payees: PayeeRuntime[]
  private readonly assets = new Map<string, AssetRecord>()
  private readonly offers = new Map<string, AssetRecord>()
  private readonly quotes = new Map<string, QuoteRecord>()
  private readonly demandIndex = new Map<string, { demand: SignedObject; payee: PayeeRuntime }>()
  private readonly licenses = new Map<string, SignedObject>()
  private readonly storedDeliveries = new Map<string, StoredDelivery>()
  private readonly deliveryClaims = new Map<string, DeliveryClaim>()
  private readonly transactionEvidence = new Map<string, SignedObject>()
  private readonly acceptedTransactions = new Map<string, string>()
  private availabilityProviderOnline = true
  private evidenceProviderOnline = true

  private constructor(
    options: ReferenceLCHServerOptions,
    private readonly issuerIdentity: Uint8Array,
    issuer: LCHIssuer,
    publisher: LCHPublisher,
    quoteIssuer: LCHQuoteIssuer,
    keyDelivery: WalletBRC78KeyDelivery,
    settlementService: LCHSettlementService,
    payees: PayeeRuntime[]
  ) {
    this.acquisitionEndpoint = `${options.publicBaseUrl}/api/lch`
    this.evidenceEndpoint = `${options.publicBaseUrl}/api/lch/evidence`
    this.deliveryEndpoint = `${options.publicBaseUrl}/api/lch/delivery-store`
    this.retrievalEndpoint = `${options.publicBaseUrl}/api/lch/delivery-retrieval`
    this.content = new ReferenceContentStore(options.publicBaseUrl)
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.issuer = issuer
    this.publisher = publisher
    this.quoteIssuer = quoteIssuer
    this.keyDelivery = keyDelivery
    this.settlementService = settlementService
    this.payees = payees
    this.payeeEndpoints = payees.map(({ label, endpoint }) => ({ label, endpoint }))
    const issuerHttp = new LCHHttpServer({
      handlers: {
        preflightLicense: request => this.preflightLicense(request),
        quote: request => this.quote(request),
        complete: completion => this.complete(completion),
        recover: requestId => this.recover(requestId)
      }
    })
    const payeeHttp = new Map(
      payees.map(
        payee =>
          [
            payee.endpoint,
            new LCHHttpServer({
              handlers: {
                preflightDemand: demand => this.preflightDemandFor(payee, demand),
                authorizePayment: demand => this.authorizePaymentFor(payee, demand),
                paymentDelivery: delivery => this.receivePaymentFor(payee, delivery)
              }
            })
          ] as const
      )
    )
    const evidenceHttp = new LCHHttpServer({
      handlers: { attestTransaction: request => this.attestTransaction(request) }
    })
    const deliveryHttp = new LCHHttpServer({
      handlers: { storeDelivery: request => this.storeDelivery(request) }
    })
    const retrievalHttp = new LCHHttpServer({
      handlers: { retrieveDelivery: request => this.retrieveDelivery(request) }
    })
    const endpointHandlers = new Map(payeeHttp)
    endpointHandlers.set(this.acquisitionEndpoint, issuerHttp)
    endpointHandlers.set(this.evidenceEndpoint, evidenceHttp)
    endpointHandlers.set(this.deliveryEndpoint, deliveryHttp)
    endpointHandlers.set(this.retrievalEndpoint, retrievalHttp)
    this.http = {
      handle: request => {
        const endpoint = requestEndpoint(request.url)
        const handler = endpointHandlers.get(endpoint)
        return handler?.handle(request) ?? Promise.resolve(new Response(null, { status: 404 }))
      }
    }
  }

  static async create(options: ReferenceLCHServerOptions): Promise<ReferenceLCHServer> {
    if (options.payees.length < 2)
      throw new TypeError('The multilateral reference flow requires at least two Payee wallets')
    const issuerSigner = await WalletBRC77Signer.create({ wallet: options.issuerWallet })
    const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    const payees = await Promise.all(
      options.payees.map(async payeeOptions => {
        const signer = await WalletBRC77Signer.create({ wallet: payeeOptions.wallet })
        const endpoint =
          payeeOptions.endpoint ??
          `${options.publicBaseUrl}/api/lch/payees/${encodeURIComponent(payeeOptions.interest)}`
        return {
          ...payeeOptions,
          settlementProfile:
            payeeOptions.settlementProfile ?? LCH_SETTLEMENT_PROFILES.receiptComplete,
          endpoint,
          identityKey: signer.identityKey,
          payee: new LCHPayee(signer),
          authorizer: new WalletAuthorizedOutputPayee({
            wallet: payeeOptions.wallet,
            signer,
            now,
            allowInsecureLocalOrigins: isLocalHttp(endpoint) ? [new URL(endpoint).origin] : []
          }),
          online: true,
          offlineAfterNextReadiness: false,
          receiver: new WalletPaymentReceiver({
            wallet: payeeOptions.wallet,
            signer,
            now,
            allowInsecureLocalOrigins: isLocalHttp(endpoint) ? [new URL(endpoint).origin] : []
          })
        }
      })
    )
    return new ReferenceLCHServer(
      options,
      issuerSigner.identityKey,
      new LCHIssuer(issuerSigner),
      new LCHPublisher(issuerSigner),
      new LCHQuoteIssuer(issuerSigner),
      new WalletBRC78KeyDelivery(options.issuerWallet),
      new LCHSettlementService(issuerSigner),
      payees
    )
  }

  async publish(input: ReferencePublishRequest): Promise<ReferencePublishedAsset> {
    const protectedAsset = await this.publisher.protect(input.bytes, {
      mediaType: input.mediaType,
      name: input.name,
      rights: [
        {
          interest: 'licensed-work',
          holder: { name: 'LCH reference creator' },
          controller: this.issuerIdentity
        }
      ],
      sink: this.content,
      segmentSize: 16 * 1024,
      keyPeriodSegments: 1
    })
    const target = `lch:asset:sha256:${toHex(protectedAsset.assetId)}`
    const duties = this.payees.map(payee => ({
      uid: payee.dutyUid,
      action: 'compensate',
      compensatedParty: `lch:identity:secp256k1:${toHex(payee.identityKey)}`,
      payAmount: { value: payee.satoshis, unit: 'lchv:satoshi' }
    }))
    const policyBytes = new TextEncoder().encode(
      JSON.stringify({
        '@context': ['http://www.w3.org/ns/odrl.jsonld'],
        '@type': 'Offer',
        uid: 'lch:offer:self',
        profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
        permission: [
          { target, action: 'play', duty: duties },
          { target, action: 'derive', duty: duties }
        ],
        prohibition: [{ target, action: 'unwrap' }]
      })
    )
    const policyDigest = await sha256(policyBytes)
    const now = this.now()
    const offer = await this.issuer.createOffer({
      assetId: protectedAsset.assetId,
      usageProfile: LCH_PROFILES.fixedRender,
      seller: this.issuerIdentity,
      licenseIssuer: this.issuerIdentity,
      requiredInterests: ['licensed-work'],
      policy: {
        mediaType: 'application/ld+json',
        digest: policyDigest,
        inline: policyBytes
      },
      payment: {
        protocol: LCH_MECHANISMS.brc105Multipay,
        endpoint: this.acquisitionEndpoint,
        asset: 'BSV',
        unit: 'satoshi',
        recoveryPeriodSeconds: 86_400,
        pricing: {
          kind: 'fixed',
          requirements: this.payees.map(payee => ({
            dutyUid: payee.dutyUid,
            payee: payee.identityKey,
            endpoint: payee.endpoint,
            satoshis: payee.satoshis,
            interest: payee.interest
          }))
        }
      },
      keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
      enforcement: {
        class: 'https://bsv.brc.dev/apps/0170#conformingApplication',
        connectivity: 'https://bsv.brc.dev/apps/0170#either'
      },
      notBefore: now,
      nonce: crypto.getRandomValues(new Uint8Array(16))
    })
    const offerId = await objectId('offer', offer.body)
    const published = await this.publisher.publish(
      protectedAsset,
      [{ mode: 'inline', offer } as unknown as Record<string, LCHValue>],
      false
    )
    const record: AssetRecord = {
      assetId: protectedAsset.assetId,
      offerId,
      lch: published.bytes,
      acquisitionEndpoint: this.acquisitionEndpoint,
      protectedAsset,
      offer,
      policyDigest,
      mediaType: input.mediaType,
      name: input.name
    }
    this.assets.set(toHex(record.assetId), record)
    this.offers.set(toHex(record.offerId), record)
    return publicAsset(record)
  }

  asset(assetId: string): ReferencePublishedAsset | undefined {
    const record = this.assets.get(assetId)
    return record === undefined ? undefined : publicAsset(record)
  }

  setPayeeOnline(label: string, online: boolean): void {
    this.payeeByLabel(label).online = online
  }

  setPayeeOfflineAfterNextReadiness(label: string, enabled = true): void {
    this.payeeByLabel(label).offlineAfterNextReadiness = enabled
  }

  setAvailabilityProviderOnline(online: boolean): void {
    this.availabilityProviderOnline = online
  }

  setEvidenceProviderOnline(online: boolean): void {
    this.evidenceProviderOnline = online
  }

  async recoverStoredPayments(label: string): Promise<SignedObject[]> {
    const payee = this.payeeByLabel(label)
    if (!payee.online) throw new Error('Payee endpoint is offline')
    const receipts: SignedObject[] = []
    for (const stored of this.storedDeliveries.values()) {
      if (stored.payee !== payee) continue
      const request = await payee.payee.createDeliveryRetrieval({
        authorizationId: await objectId('payment-authorization', stored.authorization.body),
        requestedAt: this.now()
      })
      const retrieved = await this.retrieveDelivery(request)
      if (retrieved === undefined) throw new Error('Stored Payment Delivery is unavailable')
      receipts.push(
        await payee.receiver.receive(this.demandFor(retrieved.delivery), retrieved.delivery)
      )
    }
    return receipts
  }

  async preflightLicense(request: SignedObject): Promise<void> {
    const requestId = await validateLicenseRequest(request)
    const asset = this.requestAsset(request)
    this.validateRequestTerms(request, asset)
    await new LCHReader(this.content).resolve(await new LCHReader(this.content).inspect(asset.lch))
    const existing = this.quotes.get(toHex(requestId))
    if (existing !== undefined && toHex(existing.asset.assetId) !== toHex(asset.assetId))
      throw new Error('Request ID was reused for another Asset')
  }

  async quote(request: SignedObject): Promise<SignedObject> {
    await this.preflightLicense(request)
    const requestId = await objectId('license-request', request.body)
    const key = toHex(requestId)
    const existing = this.quotes.get(key)
    if (existing !== undefined) return existing.quote
    const asset = this.requestAsset(request)
    const expiresAt = this.now() + 300n
    const buyer = bytes(request.body.buyer, 33, 'Request buyer identity')
    const demands = new Map<string, { demand: SignedObject; payee: PayeeRuntime }>()
    for (const payee of this.payees) {
      const demand = await payee.payee.createDemand({
        requestId,
        offerId: asset.offerId,
        dutyUid: payee.dutyUid,
        buyer,
        endpoint: payee.endpoint,
        satoshis: payee.satoshis,
        expiresAt,
        recoveryPeriodSeconds: 86_400,
        settlementProfile: payee.settlementProfile,
        allowInsecureLocalEndpoint: isLocalHttp(this.acquisitionEndpoint)
      })
      const demandId = toHex(await objectId('payment-demand', demand.body))
      const runtime = { demand, payee }
      demands.set(demandId, runtime)
      this.demandIndex.set(demandId, runtime)
    }
    const quote = await this.quoteIssuer.createQuote({
      requestId,
      offerId: asset.offerId,
      assetId: asset.assetId,
      buyer,
      selection: selection(request.body.selection),
      demands: [...demands.values()].map(item => item.demand),
      expiresAt,
      recoveryPeriodSeconds: 86_400
    })
    this.quotes.set(key, { asset, request, quote, demands })
    return quote
  }

  async preflightDemand(demand: SignedObject): Promise<SignedObject> {
    const demandId = toHex(await objectId('payment-demand', demand.body))
    const runtime = this.demandIndex.get(demandId)
    if (runtime === undefined) throw new Error('Payment Demand is unknown')
    if (!runtime.payee.online) throw new Error('Payee endpoint is offline')
    await runtime.payee.receiver.preflight(demand)
    return this.createReadiness(runtime.payee, runtime.demand, hex(demandId))
  }

  async receivePayment(delivery: SignedObject): Promise<SignedObject> {
    const demandId = delivery.body.demandId
    if (!(demandId instanceof Uint8Array)) throw new Error('Payment Delivery has no Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime === undefined) throw new Error('Payment Demand is unknown')
    if (!runtime.payee.online) throw new Error('Payee endpoint is offline')
    return runtime.payee.receiver.receive(runtime.demand, delivery)
  }

  private async preflightDemandFor(
    payee: PayeeRuntime,
    demand: SignedObject
  ): Promise<SignedObject> {
    const demandId = toHex(await objectId('payment-demand', demand.body))
    const runtime = this.demandIndex.get(demandId)
    if (runtime?.payee !== payee) throw new Error('Payment Demand belongs to another endpoint')
    if (!payee.online) throw new Error('Payee endpoint is offline')
    await runtime.payee.receiver.preflight(demand)
    const readiness = await this.createReadiness(payee, runtime.demand, hex(demandId))
    if (payee.offlineAfterNextReadiness) {
      payee.offlineAfterNextReadiness = false
      payee.online = false
    }
    return readiness
  }

  private async authorizePaymentFor(
    payee: PayeeRuntime,
    demand: SignedObject
  ): Promise<SignedObject> {
    const demandId = toHex(await objectId('payment-demand', demand.body))
    const runtime = this.demandIndex.get(demandId)
    if (runtime?.payee !== payee) throw new Error('Payment Demand belongs to another endpoint')
    if (!payee.online) throw new Error('Payee endpoint is offline')
    return payee.authorizer.authorize(demand, {
      evidenceProvider: this.issuerIdentity,
      evidenceEndpoint: this.evidenceEndpoint,
      evidencePolicy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
      minimumTransactionState: 'accepted',
      deliveryProvider: this.issuerIdentity,
      deliveryEndpoint: this.deliveryEndpoint,
      retrievalEndpoint: this.retrievalEndpoint,
      allowInsecureLocalEndpoint: isLocalHttp(this.acquisitionEndpoint)
    })
  }

  private createReadiness(
    payee: PayeeRuntime,
    demand: SignedObject,
    demandId: Uint8Array
  ): Promise<SignedObject> {
    const issuedAt = this.now()
    const expiresAt = BigInt(demand.body.expiresAt as number | bigint)
    const readyUntil = issuedAt + 60n < expiresAt ? issuedAt + 60n : expiresAt
    return payee.payee.createReadiness({
      demandId,
      requestId: bytes(demand.body.requestId, 32, 'Request ID'),
      buyer: bytes(demand.body.buyer, 33, 'Buyer identity'),
      issuedAt,
      readyUntil,
      recoveryUntil: BigInt(demand.body.recoveryUntil as number | bigint)
    })
  }

  private async receivePaymentFor(
    payee: PayeeRuntime,
    delivery: SignedObject
  ): Promise<SignedObject> {
    const demandId = delivery.body.demandId
    if (!(demandId instanceof Uint8Array)) throw new Error('Payment Delivery has no Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime?.payee !== payee) throw new Error('Payment Demand belongs to another endpoint')
    if (!payee.online) throw new Error('Payee endpoint is offline')
    return runtime.payee.receiver.receive(runtime.demand, delivery)
  }

  private async storeDelivery(request: PaymentDeliveryStoreRequest): Promise<SignedObject> {
    if (!this.availabilityProviderOnline) throw new Error('Delivery provider is unavailable')
    const demandId = bytes(request.authorization.body.demandId, 32, 'Authorization Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime === undefined) throw new Error('Payment Authorization refers to an unknown Demand')
    const authorizationId = await validatePaymentAuthorization(
      request.authorization,
      runtime.demand,
      undefined,
      undefined,
      this.validationOptions()
    )
    await validatePaymentDelivery(request.delivery)
    equal(request.delivery.body.demandId, demandId, 'Delivery Demand ID')
    const key = toHex(authorizationId)
    const existing = this.storedDeliveries.get(key)
    if (existing !== undefined) {
      equalObject(existing.authorization, request.authorization, 'Stored Payment Authorization')
      equalObject(existing.delivery, request.delivery, 'Stored Payment Delivery')
      return existing.acknowledgement
    }
    const authorizationBytes = encodeDeterministicCbor(request.authorization as unknown as LCHValue)
    const deliveryBytes = encodeDeterministicCbor(request.delivery as unknown as LCHValue)
    const claimed = this.deliveryClaims.get(key)
    if (claimed !== undefined) {
      equal(authorizationBytes, claimed.authorizationBytes, 'Stored Payment Authorization')
      equal(deliveryBytes, claimed.deliveryBytes, 'Stored Payment Delivery')
      return claimed.completion
    }

    // Claim the byte-exact Authorization/Delivery pair synchronously. This keeps
    // concurrent requests idempotent and rejects a second Delivery before the
    // acknowledgement signer yields.
    const completion = Promise.resolve().then(async (): Promise<SignedObject> => {
      const acknowledgement = await this.settlementService.createDeliveryAcknowledgement({
        authorizationId,
        deliveryId: await objectId('payment-delivery', request.delivery.body),
        demandId,
        requestId: bytes(request.delivery.body.requestId, 32, 'Delivery Request ID'),
        payee: runtime.payee.identityKey,
        storedAt: this.now(),
        availableUntil: BigInt(request.authorization.body.recoveryUntil as number | bigint),
        retrievalEndpoint: this.retrievalEndpoint,
        allowInsecureLocalEndpoint: isLocalHttp(this.retrievalEndpoint)
      })
      this.storedDeliveries.set(key, {
        authorization: request.authorization,
        delivery: request.delivery,
        acknowledgement,
        payee: runtime.payee
      })
      return acknowledgement
    })
    const claim = { authorizationBytes, deliveryBytes, completion }
    this.deliveryClaims.set(key, claim)
    try {
      return await completion
    } catch (error) {
      if (this.deliveryClaims.get(key) === claim) this.deliveryClaims.delete(key)
      throw error
    }
  }

  private async attestTransaction(request: TransactionEvidenceRequest): Promise<SignedObject> {
    if (!this.evidenceProviderOnline)
      throw new Error('Transaction evidence provider is unavailable')
    const demandId = bytes(request.authorization.body.demandId, 32, 'Authorization Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime === undefined) throw new Error('Payment Authorization refers to an unknown Demand')
    const authorizationId = await validatePaymentAuthorization(
      request.authorization,
      runtime.demand,
      undefined,
      undefined,
      this.validationOptions()
    )
    const key = toHex(authorizationId)
    const transaction = Transaction.fromAtomicBEEF(request.atomicBeef as AtomicBEEF)
    const matchingOutputs = transaction.outputs.filter(
      output =>
        output.satoshis !== undefined &&
        BigInt(output.satoshis) === BigInt(runtime.payee.satoshis) &&
        toHex(output.lockingScript.toUint8Array()) ===
          toHex(bytes(request.authorization.body.lockingScript, undefined, 'Authorized script'))
    )
    if (matchingOutputs.length !== 1)
      throw new LCHError(
        'ERR_LCH_PAYMENT',
        'Accepted transaction does not contain exactly one authorized output'
      )
    const txid = transaction.id('hex')
    const accepted = this.acceptedTransactions.get(key)
    if (accepted !== undefined && accepted !== txid)
      throw new LCHError(
        'ERR_LCH_PAYMENT',
        'Payment Authorization was already bound to another accepted transaction'
      )
    const existing = this.transactionEvidence.get(key)
    if (existing !== undefined) return existing
    this.acceptedTransactions.set(key, txid)
    const evidence = await this.settlementService.createTransactionEvidence({
      authorizationId,
      txid: hex(txid),
      state: 'accepted',
      policy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
      observedAt: this.now()
    })
    this.transactionEvidence.set(key, evidence)
    return evidence
  }

  private async retrieveDelivery(
    request: SignedObject
  ): Promise<StoredPaymentDelivery | undefined> {
    const authorizationId = bytes(request.body.authorizationId, 32, 'Retrieval Authorization ID')
    const stored = this.storedDeliveries.get(toHex(authorizationId))
    if (stored === undefined) return undefined
    await validatePaymentDeliveryRetrieval(request, stored.authorization)
    const requestedAt = BigInt(request.body.requestedAt as number | bigint)
    const authorizedAt = BigInt(stored.authorization.body.authorizedAt as number | bigint)
    const availableUntil = BigInt(stored.acknowledgement.body.availableUntil as number | bigint)
    if (requestedAt < authorizedAt || requestedAt >= availableUntil)
      throw new Error('Delivery retrieval time is outside the retained window')
    return {
      authorization: stored.authorization,
      delivery: stored.delivery,
      deliveryAcknowledgement: stored.acknowledgement
    }
  }

  async complete(completion: PaymentCompletion): Promise<SignedObject> {
    const requestId = await validateLicenseRequest(completion.request)
    const key = toHex(requestId)
    const quoteRecord = this.quotes.get(key)
    if (quoteRecord === undefined) throw new Error('Quote is unknown')
    equalObject(completion.quote, quoteRecord.quote, 'Quote')
    const transaction = Transaction.fromAtomicBEEF(completion.atomicBeef as AtomicBEEF)
    const outputIndices = new Set<number>()
    const receipts = await this.validateReceiptProofs(
      completion,
      quoteRecord,
      transaction,
      requestId,
      outputIndices
    )
    const authorizedOutputs = await this.validateAuthorizedOutputProofs(
      completion,
      quoteRecord,
      receipts,
      outputIndices
    )
    if (receipts.size + authorizedOutputs.size !== quoteRecord.demands.size)
      throw new Error('A required settlement proof is missing')
    const existing = this.licenses.get(key)
    if (existing !== undefined) return existing

    const buyer = bytes(completion.request.body.buyer, 33, 'Buyer identity')
    const keyGrants = await Promise.all(
      [...quoteRecord.asset.protectedAsset.keys.entries()].map(async ([keyIdHex, cek]) => ({
        keyId: hex(keyIdHex),
        delivery: LCH_MECHANISMS.brc78Key,
        payload: await this.keyDelivery.deliver(toHex(buyer), hex(keyIdHex), cek)
      }))
    )
    const target = `lch:asset:sha256:${toHex(quoteRecord.asset.assetId)}`
    const agreementBytes = new TextEncoder().encode(
      JSON.stringify({
        '@context': ['http://www.w3.org/ns/odrl.jsonld'],
        '@type': 'Agreement',
        uid: 'lch:license:self',
        profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
        assignee: `lch:identity:secp256k1:${toHex(buyer)}`,
        permission: [
          { target, action: completion.request.body.action },
          { target, action: 'derive' }
        ],
        prohibition: [{ target, action: 'unwrap' }]
      })
    )
    const license = await this.issuer.issueLicense({
      assetId: quoteRecord.asset.assetId,
      offerId: quoteRecord.asset.offerId,
      requestId,
      issuer: this.issuerIdentity,
      subject: buyer,
      issuedAt: this.now(),
      agreement: {
        mediaType: 'application/ld+json',
        digest: await sha256(agreementBytes),
        inline: agreementBytes
      },
      selection: selection(completion.request.body.selection),
      fulfillments: await Promise.all(
        [...quoteRecord.demands].map(async ([demandId, runtime]) => {
          const receipt = receipts.get(demandId)
          const bundle = authorizedOutputs.get(demandId)
          return {
            dutyUid: runtime.demand.body.dutyUid as string,
            settlementProfile: runtime.demand.body.settlementProfile as string,
            ...(receipt === undefined
              ? {
                  authorizationId: await objectId(
                    'payment-authorization',
                    bundle!.authorization.body
                  ),
                  transactionEvidenceId: await objectId(
                    'transaction-evidence',
                    bundle!.transactionEvidence.body
                  ),
                  deliveryAcknowledgementId: await objectId(
                    'payment-delivery-ack',
                    bundle!.deliveryAcknowledgement.body
                  )
                }
              : { receiptIds: [await objectId('payment-receipt', receipt.body)] })
          }
        })
      ),
      keyGrants,
      encryption: (
        quoteRecord.asset.protectedAsset.asset.representation as Record<string, LCHValue>
      ).encryption as never
    })
    this.licenses.set(key, license)
    return license
  }

  private async validateReceiptProofs(
    completion: PaymentCompletion,
    quoteRecord: QuoteRecord,
    transaction: Transaction,
    requestId: Uint8Array,
    outputIndices: Set<number>
  ): Promise<Map<string, SignedObject>> {
    const receipts = new Map<string, SignedObject>()
    const txid = transaction.id('hex')
    for (const receipt of completion.receipts) {
      await validatePaymentReceipt(receipt)
      const demandId = bytes(receipt.body.demandId, 32, 'Receipt Demand ID')
      const demandIdHex = toHex(demandId)
      const runtime = quoteRecord.demands.get(demandIdHex)
      if (runtime === undefined) throw new Error('Receipt is not required by the Quote')
      equal(receipt.body.requestId, requestId, 'Receipt Request ID')
      equal(receipt.body.payee, runtime.demand.body.payee, 'Receipt Payee')
      if (toHex(bytes(receipt.body.txid, 32, 'Receipt transaction ID')) !== txid)
        throw new Error('Receipt transaction does not match Atomic BEEF')
      const outputIndex = Number(receipt.body.outputIndex)
      uniqueOutputIndex(outputIndex, outputIndices, 'Receipt')
      const output = transaction.outputs[outputIndex]
      if (
        output?.satoshis === undefined ||
        BigInt(output.satoshis) !== BigInt(runtime.payee.satoshis) ||
        BigInt(receipt.body.satoshis as number | bigint) !== BigInt(runtime.payee.satoshis)
      )
        throw new Error('Receipt amount does not match the Demand')
      outputIndices.add(outputIndex)
      if (receipts.has(demandIdHex)) throw new Error('Payment Receipt is duplicated')
      receipts.set(demandIdHex, receipt)
    }
    return receipts
  }

  private async validateAuthorizedOutputProofs(
    completion: PaymentCompletion,
    quoteRecord: QuoteRecord,
    receipts: ReadonlyMap<string, SignedObject>,
    outputIndices: Set<number>
  ): Promise<Map<string, AuthorizedOutputEvidence>> {
    const authorizedOutputs = new Map<string, AuthorizedOutputEvidence>()
    for (const bundle of completion.authorizedOutputs ?? []) {
      const demandId = bytes(bundle.authorization.body.demandId, 32, 'Authorization Demand ID')
      const demandIdHex = toHex(demandId)
      const runtime = quoteRecord.demands.get(demandIdHex)
      if (runtime === undefined) throw new Error('Authorized output is not required by the Quote')
      if (receipts.has(demandIdHex) || authorizedOutputs.has(demandIdHex))
        throw new Error('Payment Demand has more than one settlement proof')
      await validateAuthorizedOutputEvidence(
        bundle,
        runtime.demand,
        completion.atomicBeef,
        undefined,
        this.validationOptions()
      )
      const outputIndex = Number(bundle.delivery.body.outputIndex)
      uniqueOutputIndex(outputIndex, outputIndices, 'Authorized output')
      outputIndices.add(outputIndex)
      authorizedOutputs.set(demandIdHex, bundle)
    }
    return authorizedOutputs
  }

  async recover(requestId: Uint8Array): Promise<SignedObject | undefined> {
    return this.licenses.get(toHex(requestId))
  }

  private payeeByLabel(label: string): PayeeRuntime {
    const payee = this.payees.find(candidate => candidate.label === label)
    if (payee === undefined) throw new Error(`Unknown Payee: ${label}`)
    return payee
  }

  private demandFor(delivery: SignedObject): SignedObject {
    const demandId = bytes(delivery.body.demandId, 32, 'Delivery Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime === undefined) throw new Error('Payment Delivery refers to an unknown Demand')
    return runtime.demand
  }

  private validationOptions(): { allowInsecureLocalOrigins: string[] } {
    const origin = new URL(this.acquisitionEndpoint).origin
    return { allowInsecureLocalOrigins: isLocalHttp(this.acquisitionEndpoint) ? [origin] : [] }
  }

  private requestAsset(request: SignedObject): AssetRecord {
    const offerId = bytes(request.body.offerId, 32, 'Request Offer ID')
    const asset = this.offers.get(toHex(offerId))
    if (asset === undefined) throw new Error('Offer is unknown')
    equal(request.body.assetId, asset.assetId, 'Request Asset ID')
    return asset
  }

  private validateRequestTerms(request: SignedObject, asset: AssetRecord): void {
    equal(request.body.acceptedPolicyDigest, asset.policyDigest, 'Accepted Policy digest')
    if (!['play', 'derive'].includes(request.body.action as string))
      throw new Error('Requested action is not offered')
  }
}

function requestEndpoint(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname}${url.search}`
}

export function referenceApiResponse(value: ReferencePublishedAsset): Response {
  const body = {
    assetId: toHex(value.assetId),
    offerId: toHex(value.offerId),
    acquisitionEndpoint: value.acquisitionEndpoint,
    lchBase64url: toBase64Url(value.lch)
  }
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}

function publicAsset(record: AssetRecord): ReferencePublishedAsset {
  return {
    assetId: record.assetId,
    offerId: record.offerId,
    lch: record.lch,
    acquisitionEndpoint: record.acquisitionEndpoint
  }
}

function isLocalHttp(value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
}

function selection(value: LCHValue | undefined): { type: 'all' } {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value.type !== 'all'
  )
    throw new Error('Reference server currently expects the whole-Asset selection')
  return { type: 'all' }
}

function bytes(value: unknown, length: number | undefined, name: string): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.length === 0 ||
    (length !== undefined && value.length !== length)
  )
    throw new Error(`${name} is invalid`)
  return value
}

function equal(value: unknown, expected: unknown, name: string): void {
  if (
    !(value instanceof Uint8Array) ||
    !(expected instanceof Uint8Array) ||
    toHex(value) !== toHex(expected)
  )
    throw new Error(`${name} does not match`)
}

function equalObject(value: SignedObject, expected: SignedObject, name: string): void {
  if (
    toHex(encodeDeterministicCbor(value as unknown as LCHValue)) !==
    toHex(encodeDeterministicCbor(expected as unknown as LCHValue))
  )
    throw new Error(`${name} does not match`)
}

function uniqueOutputIndex(value: number, used: ReadonlySet<number>, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || used.has(value))
    throw new Error(`${name} index is invalid or duplicated`)
}

function hex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('Key ID is invalid')
  return Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16))
}
