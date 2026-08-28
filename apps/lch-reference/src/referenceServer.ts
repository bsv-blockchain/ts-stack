import { Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import {
  LCHHttpServer,
  LCHIssuer,
  LCHPayee,
  LCHPublisher,
  LCHQuoteIssuer,
  LCHReader,
  LCH_MECHANISMS,
  LCH_PROFILES,
  WalletBRC77Signer,
  WalletBRC78KeyDelivery,
  WalletPaymentReceiver,
  encodeDeterministicCbor,
  objectId,
  sha256,
  toBase64Url,
  toHex,
  validateLicenseRequest,
  validatePaymentReceipt,
  type ContentSink,
  type ContentSource,
  type LCHValue,
  type PaymentCompletion,
  type ProtectedAsset,
  type SignedObject
} from '@bsv/lch'

export interface ReferencePayeeOptions {
  wallet: WalletInterface
  satoshis: number
  dutyUid: string
  interest: string
  label: string
  endpoint?: string
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
  readonly payeeEndpoints: ReadonlyArray<{ label: string; endpoint: string }>
  readonly content: ReferenceContentStore
  readonly http: Pick<LCHHttpServer, 'handle'>

  private readonly now: () => bigint
  private readonly issuer: LCHIssuer
  private readonly publisher: LCHPublisher
  private readonly quoteIssuer: LCHQuoteIssuer
  private readonly keyDelivery: WalletBRC78KeyDelivery
  private readonly payees: PayeeRuntime[]
  private readonly assets = new Map<string, AssetRecord>()
  private readonly offers = new Map<string, AssetRecord>()
  private readonly quotes = new Map<string, QuoteRecord>()
  private readonly demandIndex = new Map<string, { demand: SignedObject; payee: PayeeRuntime }>()
  private readonly licenses = new Map<string, SignedObject>()

  private constructor(
    options: ReferenceLCHServerOptions,
    private readonly issuerIdentity: Uint8Array,
    issuer: LCHIssuer,
    publisher: LCHPublisher,
    quoteIssuer: LCHQuoteIssuer,
    keyDelivery: WalletBRC78KeyDelivery,
    payees: PayeeRuntime[]
  ) {
    this.acquisitionEndpoint = `${options.publicBaseUrl}/api/lch`
    this.content = new ReferenceContentStore(options.publicBaseUrl)
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.issuer = issuer
    this.publisher = publisher
    this.quoteIssuer = quoteIssuer
    this.keyDelivery = keyDelivery
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
                paymentDelivery: delivery => this.receivePaymentFor(payee, delivery)
              }
            })
          ] as const
      )
    )
    this.http = {
      handle: request => {
        const endpoint = requestEndpoint(request.url)
        const handler = endpoint === this.acquisitionEndpoint ? issuerHttp : payeeHttp.get(endpoint)
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
          endpoint,
          identityKey: signer.identityKey,
          payee: new LCHPayee(signer),
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
    await runtime.payee.receiver.preflight(demand)
    return this.createReadiness(runtime.payee, runtime.demand, hex(demandId))
  }

  async receivePayment(delivery: SignedObject): Promise<SignedObject> {
    const demandId = delivery.body.demandId
    if (!(demandId instanceof Uint8Array)) throw new Error('Payment Delivery has no Demand ID')
    const runtime = this.demandIndex.get(toHex(demandId))
    if (runtime === undefined) throw new Error('Payment Demand is unknown')
    return runtime.payee.receiver.receive(runtime.demand, delivery)
  }

  private async preflightDemandFor(
    payee: PayeeRuntime,
    demand: SignedObject
  ): Promise<SignedObject> {
    const demandId = toHex(await objectId('payment-demand', demand.body))
    const runtime = this.demandIndex.get(demandId)
    if (runtime?.payee !== payee) throw new Error('Payment Demand belongs to another endpoint')
    await runtime.payee.receiver.preflight(demand)
    return this.createReadiness(payee, runtime.demand, hex(demandId))
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
    return runtime.payee.receiver.receive(runtime.demand, delivery)
  }

  async complete(completion: PaymentCompletion): Promise<SignedObject> {
    const requestId = await validateLicenseRequest(completion.request)
    const key = toHex(requestId)
    const quoteRecord = this.quotes.get(key)
    if (quoteRecord === undefined) throw new Error('Quote is unknown')
    equalObject(completion.quote, quoteRecord.quote, 'Quote')
    const transaction = Transaction.fromAtomicBEEF(completion.atomicBeef as AtomicBEEF)
    const txid = transaction.id('hex')
    const receipts = new Map<string, SignedObject>()
    const outputIndices = new Set<number>()
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
      if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndices.has(outputIndex))
        throw new Error('Receipt output index is invalid or duplicated')
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
    if (receipts.size !== quoteRecord.demands.size) throw new Error('A Payment Receipt is missing')
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
        [...quoteRecord.demands].map(async ([demandId, runtime]) => ({
          dutyUid: runtime.demand.body.dutyUid as string,
          receiptIds: [await objectId('payment-receipt', receipts.get(demandId)!.body)]
        }))
      ),
      keyGrants,
      encryption: (
        quoteRecord.asset.protectedAsset.asset.representation as Record<string, LCHValue>
      ).encryption as never
    })
    this.licenses.set(key, license)
    return license
  }

  async recover(requestId: Uint8Array): Promise<SignedObject | undefined> {
    return this.licenses.get(toHex(requestId))
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

function bytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
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

function hex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('Key ID is invalid')
  return Uint8Array.from(value.match(/../gu)!, pair => Number.parseInt(pair, 16))
}
