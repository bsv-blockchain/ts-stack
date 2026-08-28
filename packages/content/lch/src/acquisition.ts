import { lchAssert } from './errors.js'
import { encodeDeterministicCbor } from './cbor.js'
import { objectId, toHex } from './hash.js'
import { signObject, verifySignedObject } from './objects.js'
import { recoveryUntil } from './payment.js'
import { normalizeSelection } from './selection.js'
import { PublicBRC77Verifier } from './signatures.js'
import type {
  LCHSignatureVerifier,
  LCHSigner,
  LCHUint,
  LCHValue,
  Selection,
  SignedObject
} from './types.js'

const MAX_UINT64 = 0xffffffffffffffffn

export interface LicenseRequestOptions {
  offerId: Uint8Array
  assetId: Uint8Array
  buyer?: Uint8Array
  action: string
  selection: Selection
  acceptedPolicyDigest: Uint8Array
  acceptedHumanTermDigests?: Uint8Array[]
  requestNonce?: Uint8Array
  createdAt: LCHUint
  mechanismChoices?: Record<string, string>
  critical?: string[]
}

export interface PaymentDemandOptions {
  requestId: Uint8Array
  offerId: Uint8Array
  dutyUid: string
  payee?: Uint8Array
  buyer: Uint8Array
  endpoint: string
  satoshis: LCHUint
  derivationPrefix?: Uint8Array
  challengeNonce?: Uint8Array
  expiresAt: LCHUint
  recoveryPeriodSeconds: LCHUint
  critical?: string[]
  allowInsecureLocalEndpoint?: boolean
}

export interface QuoteOptions {
  requestId: Uint8Array
  offerId: Uint8Array
  assetId: Uint8Array
  buyer: Uint8Array
  selection: Selection
  segmentSelection?: Extract<Selection, { type: 'segments' }>
  demands: SignedObject[]
  expiresAt: LCHUint
  recoveryPeriodSeconds: LCHUint
  critical?: string[]
}

export interface PaymentDeliveryOptions {
  demandId: Uint8Array
  requestId: Uint8Array
  buyer?: Uint8Array
  atomicBeef: Uint8Array
  outputIndex: number
  derivationPrefix: Uint8Array
  derivationSuffix: Uint8Array
  critical?: string[]
}

export interface PaymentReadinessOptions {
  demandId: Uint8Array
  requestId: Uint8Array
  payee?: Uint8Array
  buyer: Uint8Array
  issuedAt: LCHUint
  readyUntil: LCHUint
  recoveryUntil: LCHUint
  critical?: string[]
}

export interface PaymentReceiptOptions {
  demandId: Uint8Array
  requestId: Uint8Array
  payee?: Uint8Array
  txid: Uint8Array
  outputIndex: number
  satoshis: LCHUint
  receivedAt: LCHUint
  critical?: string[]
}

export interface PaymentCompletion {
  request: SignedObject
  quote: SignedObject
  atomicBeef: Uint8Array
  receipts: SignedObject[]
}

export interface AcquisitionValidationOptions {
  allowInsecureLocalOrigins?: readonly string[]
}

export class LCHBuyer {
  constructor(
    private readonly signer: LCHSigner,
    private readonly random: (length: number) => Uint8Array = secureRandom
  ) {}

  async createRequest(options: LicenseRequestOptions): Promise<SignedObject> {
    bytes(options.offerId, 32, 'Offer ID')
    bytes(options.assetId, 32, 'Asset ID')
    const buyer = options.buyer ?? this.signer.identityKey
    bytes(buyer, 33, 'Buyer identity')
    lchAssert(
      toHex(buyer) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'License Request signer is not the buyer'
    )
    nonempty(options.action, 'Requested action')
    bytes(options.acceptedPolicyDigest, 32, 'Accepted Policy digest')
    for (const digest of options.acceptedHumanTermDigests ?? [])
      bytes(digest, 32, 'Accepted human-term digest')
    const requestNonce = options.requestNonce ?? this.random(16)
    bytes(requestNonce, 16, 'Request nonce')
    uint(options.createdAt, 'Request creation time', 'ERR_LCH_LICENSE')
    extensions(options.critical)
    const body: Record<string, LCHValue> = {
      version: 1,
      offerId: options.offerId,
      assetId: options.assetId,
      buyer,
      action: options.action,
      selection: normalizeSelection(options.selection) as unknown as Record<string, LCHValue>,
      acceptedPolicyDigest: options.acceptedPolicyDigest,
      ...(options.acceptedHumanTermDigests === undefined
        ? {}
        : { acceptedHumanTermDigests: options.acceptedHumanTermDigests }),
      requestNonce,
      createdAt: options.createdAt,
      ...(options.mechanismChoices === undefined
        ? {}
        : { mechanismChoices: options.mechanismChoices }),
      ...(options.critical === undefined ? {} : { critical: options.critical })
    }
    return signObject('license-request', body, this.signer)
  }

  async createPaymentDelivery(options: PaymentDeliveryOptions): Promise<SignedObject> {
    bytes(options.demandId, 32, 'Demand ID')
    bytes(options.requestId, 32, 'Request ID')
    const buyer = options.buyer ?? this.signer.identityKey
    bytes(buyer, 33, 'Buyer identity')
    lchAssert(
      toHex(buyer) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'Payment Delivery signer is not the buyer'
    )
    lchAssert(options.atomicBeef.length > 0, 'ERR_LCH_PAYMENT', 'Atomic BEEF is absent')
    outputIndex(options.outputIndex)
    bytes(options.derivationPrefix, 32, 'Derivation prefix')
    bytes(options.derivationSuffix, 32, 'Derivation suffix')
    extensions(options.critical)
    return signObject(
      'payment-delivery',
      {
        version: 1,
        demandId: options.demandId,
        requestId: options.requestId,
        buyer,
        atomicBeef: options.atomicBeef,
        outputIndex: options.outputIndex,
        derivationPrefix: options.derivationPrefix,
        derivationSuffix: options.derivationSuffix,
        ...(options.critical === undefined ? {} : { critical: options.critical })
      },
      this.signer
    )
  }
}

export class LCHPayee {
  constructor(
    private readonly signer: LCHSigner,
    private readonly random: (length: number) => Uint8Array = secureRandom
  ) {}

  async createDemand(options: PaymentDemandOptions): Promise<SignedObject> {
    bytes(options.requestId, 32, 'Request ID')
    bytes(options.offerId, 32, 'Offer ID')
    const payee = options.payee ?? this.signer.identityKey
    bytes(payee, 33, 'Payee identity')
    lchAssert(
      toHex(payee) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'Payment Demand signer is not the payee'
    )
    bytes(options.buyer, 33, 'Demand buyer identity')
    nonempty(options.dutyUid, 'Duty UID')
    endpoint(options.endpoint, options.allowInsecureLocalEndpoint)
    uint(options.satoshis, 'Demand amount', 'ERR_LCH_PAYMENT')
    const derivationPrefix = options.derivationPrefix ?? this.random(32)
    const challengeNonce = options.challengeNonce ?? this.random(16)
    bytes(derivationPrefix, 32, 'Derivation prefix')
    bytes(challengeNonce, 16, 'Challenge nonce')
    const expiresAt = uint(options.expiresAt, 'Demand expiry', 'ERR_LCH_QUOTE')
    const recovery = recoveryUntil(expiresAt, options.recoveryPeriodSeconds)
    extensions(options.critical)
    return signObject(
      'payment-demand',
      {
        version: 1,
        requestId: options.requestId,
        offerId: options.offerId,
        dutyUid: options.dutyUid,
        payee,
        buyer: options.buyer,
        endpoint: options.endpoint,
        satoshis: options.satoshis,
        derivationPrefix,
        challengeNonce,
        expiresAt: options.expiresAt,
        recoveryUntil: recovery,
        ...(options.critical === undefined ? {} : { critical: options.critical })
      },
      this.signer
    )
  }

  async createReceipt(options: PaymentReceiptOptions): Promise<SignedObject> {
    bytes(options.demandId, 32, 'Demand ID')
    bytes(options.requestId, 32, 'Request ID')
    const payee = options.payee ?? this.signer.identityKey
    bytes(payee, 33, 'Payee identity')
    lchAssert(
      toHex(payee) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'Payment Receipt signer is not the payee'
    )
    bytes(options.txid, 32, 'Transaction ID')
    outputIndex(options.outputIndex)
    uint(options.satoshis, 'Receipt amount', 'ERR_LCH_PAYMENT')
    uint(options.receivedAt, 'Receipt time', 'ERR_LCH_PAYMENT')
    extensions(options.critical)
    return signObject(
      'payment-receipt',
      {
        version: 1,
        demandId: options.demandId,
        requestId: options.requestId,
        payee,
        txid: options.txid,
        outputIndex: options.outputIndex,
        satoshis: options.satoshis,
        receivedAt: options.receivedAt,
        ...(options.critical === undefined ? {} : { critical: options.critical })
      },
      this.signer
    )
  }

  async createReadiness(options: PaymentReadinessOptions): Promise<SignedObject> {
    bytes(options.demandId, 32, 'Demand ID')
    bytes(options.requestId, 32, 'Request ID')
    const payee = options.payee ?? this.signer.identityKey
    bytes(payee, 33, 'Payee identity')
    lchAssert(
      toHex(payee) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'Payment Readiness signer is not the payee'
    )
    bytes(options.buyer, 33, 'Buyer identity')
    const issuedAt = uint(options.issuedAt, 'Readiness issue time', 'ERR_LCH_PAYMENT')
    const readyUntil = uint(options.readyUntil, 'Readiness deadline', 'ERR_LCH_PAYMENT')
    const recovery = uint(options.recoveryUntil, 'Recovery deadline', 'ERR_LCH_PAYMENT')
    lchAssert(
      issuedAt < readyUntil && readyUntil <= recovery,
      'ERR_LCH_PAYMENT',
      'Payment Readiness deadlines are invalid'
    )
    extensions(options.critical)
    return signObject(
      'payment-readiness',
      {
        version: 1,
        demandId: options.demandId,
        requestId: options.requestId,
        payee,
        buyer: options.buyer,
        issuedAt: options.issuedAt,
        readyUntil: options.readyUntil,
        recoveryUntil: options.recoveryUntil,
        ...(options.critical === undefined ? {} : { critical: options.critical })
      },
      this.signer
    )
  }
}

export class LCHQuoteIssuer {
  constructor(
    private readonly signer: LCHSigner,
    private readonly verifier: LCHSignatureVerifier = new PublicBRC77Verifier()
  ) {}

  async createQuote(options: QuoteOptions): Promise<SignedObject> {
    bytes(options.requestId, 32, 'Request ID')
    bytes(options.offerId, 32, 'Offer ID')
    bytes(options.assetId, 32, 'Asset ID')
    bytes(options.buyer, 33, 'Quote buyer identity')
    lchAssert(options.demands.length > 0, 'ERR_LCH_QUOTE', 'Quote has no Payment Demands')
    const expiresAt = uint(options.expiresAt, 'Quote expiry', 'ERR_LCH_QUOTE')
    const recovery = recoveryUntil(expiresAt, options.recoveryPeriodSeconds)
    let total = 0n
    const seen = new Set<string>()
    for (const demand of options.demands) {
      const payee = memberBytes(demand.body, 'payee', 33, 'Demand payee')
      await verifySignedObject('payment-demand', demand, this.verifier, payee)
      equalId(demand.body.requestId, options.requestId, 'Demand Request ID')
      equalId(demand.body.offerId, options.offerId, 'Demand Offer ID')
      equalId(demand.body.buyer, options.buyer, 'Demand buyer identity')
      lchAssert(
        uint(demand.body.expiresAt, 'Demand expiry', 'ERR_LCH_QUOTE') === expiresAt &&
          uint(demand.body.recoveryUntil, 'Demand recovery deadline', 'ERR_LCH_QUOTE') === recovery,
        'ERR_LCH_QUOTE',
        'Demand deadlines do not match the Quote'
      )
      const demandId = toHex(await objectId('payment-demand', demand.body))
      lchAssert(!seen.has(demandId), 'ERR_LCH_QUOTE', 'Quote repeats a Payment Demand')
      seen.add(demandId)
      total += uint(demand.body.satoshis, 'Demand amount', 'ERR_LCH_PAYMENT')
      lchAssert(total <= 2_100_000_000_000_000n, 'ERR_LCH_PAYMENT', 'Quote total is out of range')
    }
    extensions(options.critical)
    return signObject(
      'quote',
      {
        version: 1,
        requestId: options.requestId,
        offerId: options.offerId,
        assetId: options.assetId,
        selection: normalizeSelection(options.selection) as unknown as Record<string, LCHValue>,
        ...(options.segmentSelection === undefined
          ? {}
          : {
              segmentSelection: normalizeSelection(options.segmentSelection) as unknown as Record<
                string,
                LCHValue
              >
            }),
        demands: options.demands as unknown as LCHValue[],
        totalSatoshis: total,
        expiresAt: options.expiresAt,
        recoveryUntil: recovery,
        ...(options.critical === undefined ? {} : { critical: options.critical })
      },
      this.signer
    )
  }
}

export async function validateLicenseRequest(
  request: SignedObject,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier()
): Promise<Uint8Array> {
  const buyer = memberBytes(request.body, 'buyer', 33, 'Buyer identity')
  await verifySignedObject('license-request', request, verifier, buyer)
  memberBytes(request.body, 'offerId', 32, 'Offer ID')
  memberBytes(request.body, 'assetId', 32, 'Asset ID')
  nonempty(request.body.action, 'Requested action')
  memberBytes(request.body, 'acceptedPolicyDigest', 32, 'Accepted Policy digest')
  uint(request.body.createdAt, 'Request creation time', 'ERR_LCH_LICENSE')
  selection(request.body.selection)
  return objectId('license-request', request.body)
}

export async function validatePaymentDemand(
  demand: SignedObject,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  const payee = memberBytes(demand.body, 'payee', 33, 'Payee identity')
  await verifySignedObject('payment-demand', demand, verifier, payee)
  memberBytes(demand.body, 'requestId', 32, 'Request ID')
  memberBytes(demand.body, 'offerId', 32, 'Offer ID')
  memberBytes(demand.body, 'buyer', 33, 'Demand buyer identity')
  memberBytes(demand.body, 'derivationPrefix', 32, 'Derivation prefix')
  memberBytes(demand.body, 'challengeNonce', 16, 'Challenge nonce')
  nonempty(demand.body.dutyUid, 'Duty UID')
  const demandEndpoint = demand.body.endpoint
  endpoint(demandEndpoint, isAllowedLocalOrigin(demandEndpoint, options.allowInsecureLocalOrigins))
  uint(demand.body.satoshis, 'Demand amount', 'ERR_LCH_PAYMENT')
  const expires = uint(demand.body.expiresAt, 'Demand expiry', 'ERR_LCH_QUOTE')
  const recovery = uint(demand.body.recoveryUntil, 'Demand recovery deadline', 'ERR_LCH_QUOTE')
  lchAssert(expires < recovery, 'ERR_LCH_QUOTE', 'Demand recovery window is empty')
  return objectId('payment-demand', demand.body)
}

export async function validateQuote(
  quote: SignedObject,
  request: SignedObject,
  issuer: Uint8Array,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  bytes(issuer, 33, 'Quote issuer')
  const requestId = await validateLicenseRequest(request, verifier)
  await verifySignedObject('quote', quote, verifier, issuer)
  equalId(quote.body.requestId, requestId, 'Quote Request ID')
  const offerId = memberBytes(request.body, 'offerId', 32, 'Request Offer ID')
  const assetId = memberBytes(request.body, 'assetId', 32, 'Request Asset ID')
  const buyer = memberBytes(request.body, 'buyer', 33, 'Request buyer identity')
  equalId(quote.body.offerId, offerId, 'Quote Offer ID')
  equalId(quote.body.assetId, assetId, 'Quote Asset ID')
  const requestSelection = selection(request.body.selection)
  const quoteSelection = selection(quote.body.selection)
  lchAssert(
    toHex(encodeDeterministicCbor(requestSelection as unknown as LCHValue)) ===
      toHex(encodeDeterministicCbor(quoteSelection as unknown as LCHValue)),
    'ERR_LCH_SELECTION',
    'Quote selection does not match the License Request'
  )
  const demands = quote.body.demands
  lchAssert(
    Array.isArray(demands) && demands.length > 0,
    'ERR_LCH_QUOTE',
    'Quote has no Payment Demands'
  )
  const expiresAt = uint(quote.body.expiresAt, 'Quote expiry', 'ERR_LCH_QUOTE')
  const recovery = uint(quote.body.recoveryUntil, 'Quote recovery deadline', 'ERR_LCH_QUOTE')
  lchAssert(expiresAt < recovery, 'ERR_LCH_QUOTE', 'Quote recovery window is empty')
  let total = 0n
  const seen = new Set<string>()
  for (const value of demands) {
    lchAssert(
      value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Uint8Array),
      'ERR_LCH_QUOTE',
      'Quote Payment Demand is invalid'
    )
    const envelope = value as Record<string, LCHValue>
    lchAssert(
      envelope.body !== null &&
        typeof envelope.body === 'object' &&
        !Array.isArray(envelope.body) &&
        !(envelope.body instanceof Uint8Array) &&
        Array.isArray(envelope.signatures) &&
        envelope.signatures.length > 0 &&
        envelope.signatures.every(signature => signature instanceof Uint8Array),
      'ERR_LCH_QUOTE',
      'Quote Payment Demand is not a Signed Object'
    )
    const demand: SignedObject = {
      body: envelope.body as Record<string, LCHValue>,
      signatures: envelope.signatures as Uint8Array[]
    }
    const demandId = await validatePaymentDemand(demand, verifier, options)
    const demandIdHex = toHex(demandId)
    lchAssert(!seen.has(demandIdHex), 'ERR_LCH_QUOTE', 'Quote repeats a Payment Demand')
    seen.add(demandIdHex)
    equalId(demand.body.requestId, requestId, 'Demand Request ID')
    equalId(demand.body.offerId, offerId, 'Demand Offer ID')
    equalId(demand.body.buyer, buyer, 'Demand buyer identity')
    lchAssert(
      uint(demand.body.expiresAt, 'Demand expiry', 'ERR_LCH_QUOTE') === expiresAt &&
        uint(demand.body.recoveryUntil, 'Demand recovery deadline', 'ERR_LCH_QUOTE') === recovery,
      'ERR_LCH_QUOTE',
      'Demand deadlines do not match the Quote'
    )
    total += uint(demand.body.satoshis, 'Demand amount', 'ERR_LCH_PAYMENT')
    lchAssert(total <= 2_100_000_000_000_000n, 'ERR_LCH_PAYMENT', 'Quote total is out of range')
  }
  lchAssert(
    uint(quote.body.totalSatoshis, 'Quote total', 'ERR_LCH_PAYMENT') === total,
    'ERR_LCH_PAYMENT',
    'Quote total does not equal its Payment Demands'
  )
  return objectId('quote', quote.body)
}

export async function validatePaymentDelivery(
  delivery: SignedObject,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier()
): Promise<Uint8Array> {
  const buyer = memberBytes(delivery.body, 'buyer', 33, 'Buyer identity')
  await verifySignedObject('payment-delivery', delivery, verifier, buyer)
  memberBytes(delivery.body, 'demandId', 32, 'Demand ID')
  memberBytes(delivery.body, 'requestId', 32, 'Request ID')
  memberBytes(delivery.body, 'derivationPrefix', 32, 'Derivation prefix')
  memberBytes(delivery.body, 'derivationSuffix', 32, 'Derivation suffix')
  memberBytes(delivery.body, 'atomicBeef', undefined, 'Atomic BEEF')
  outputIndex(delivery.body.outputIndex)
  return objectId('payment-delivery', delivery.body)
}

export async function validatePaymentReadiness(
  readiness: SignedObject,
  demand: SignedObject,
  now: LCHUint,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  const demandId = await validatePaymentDemand(demand, verifier, options)
  const payee = memberBytes(readiness.body, 'payee', 33, 'Payee identity')
  await verifySignedObject('payment-readiness', readiness, verifier, payee)
  equalId(readiness.body.demandId, demandId, 'Readiness Demand ID')
  equalId(
    readiness.body.requestId,
    memberBytes(demand.body, 'requestId', 32, 'Demand Request ID'),
    'Readiness Request ID'
  )
  equalId(
    readiness.body.payee,
    memberBytes(demand.body, 'payee', 33, 'Demand Payee'),
    'Readiness Payee'
  )
  equalId(
    readiness.body.buyer,
    memberBytes(demand.body, 'buyer', 33, 'Demand buyer identity'),
    'Readiness buyer identity'
  )
  const issuedAt = uint(readiness.body.issuedAt, 'Readiness issue time', 'ERR_LCH_PAYMENT')
  const readyUntil = uint(readiness.body.readyUntil, 'Readiness deadline', 'ERR_LCH_PAYMENT')
  const current = uint(now, 'Readiness validation time', 'ERR_LCH_PAYMENT')
  const expiresAt = uint(demand.body.expiresAt, 'Demand expiry', 'ERR_LCH_QUOTE')
  const recovery = uint(demand.body.recoveryUntil, 'Demand recovery deadline', 'ERR_LCH_QUOTE')
  lchAssert(
    issuedAt <= current && current < readyUntil && readyUntil <= expiresAt,
    'ERR_LCH_PAYMENT',
    'Payment Readiness is not currently valid'
  )
  lchAssert(
    uint(readiness.body.recoveryUntil, 'Readiness recovery deadline', 'ERR_LCH_PAYMENT') ===
      recovery,
    'ERR_LCH_PAYMENT',
    'Payment Readiness recovery deadline does not match the Demand'
  )
  return objectId('payment-readiness', readiness.body)
}

export async function validatePaymentReceipt(
  receipt: SignedObject,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier()
): Promise<Uint8Array> {
  const payee = memberBytes(receipt.body, 'payee', 33, 'Payee identity')
  await verifySignedObject('payment-receipt', receipt, verifier, payee)
  memberBytes(receipt.body, 'demandId', 32, 'Demand ID')
  memberBytes(receipt.body, 'requestId', 32, 'Request ID')
  memberBytes(receipt.body, 'txid', 32, 'Transaction ID')
  outputIndex(receipt.body.outputIndex)
  uint(receipt.body.satoshis, 'Receipt amount', 'ERR_LCH_PAYMENT')
  uint(receipt.body.receivedAt, 'Receipt time', 'ERR_LCH_PAYMENT')
  return objectId('payment-receipt', receipt.body)
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function bytes(
  value: unknown,
  length: number | undefined,
  name: string
): asserts value is Uint8Array {
  lchAssert(
    value instanceof Uint8Array &&
      value.length > 0 &&
      (length === undefined || value.length === length),
    'ERR_LCH_FRAMING',
    `${name} is invalid`
  )
}

function memberBytes(
  body: Record<string, LCHValue>,
  key: string,
  length: number | undefined,
  name: string
): Uint8Array {
  const value = body[key]
  bytes(value, length, name)
  return value
}

function uint(
  value: unknown,
  name: string,
  code: 'ERR_LCH_LICENSE' | 'ERR_LCH_PAYMENT' | 'ERR_LCH_QUOTE'
): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    code,
    `${name} must be an exact integer`
  )
  const result = BigInt(value)
  lchAssert(result >= 0n && result <= MAX_UINT64, code, `${name} is outside uint64`)
  return result
}

function nonempty(value: unknown, name: string): asserts value is string {
  lchAssert(typeof value === 'string' && value.length > 0, 'ERR_LCH_FRAMING', `${name} is absent`)
}

function endpoint(value: unknown, allowInsecureLocal = false): void {
  nonempty(value, 'Endpoint')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    lchAssert(false, 'ERR_LCH_ENDPOINT', 'Endpoint is not an absolute URL')
  }
  lchAssert(
    (parsed.protocol === 'https:' ||
      (allowInsecureLocal &&
        parsed.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname))) &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '',
    'ERR_LCH_ENDPOINT',
    'Endpoint must be HTTPS without userinfo or fragment'
  )
}

function isAllowedLocalOrigin(value: unknown, allowed: readonly string[] | undefined): boolean {
  if (typeof value !== 'string' || allowed === undefined) return false
  try {
    return allowed.includes(new URL(value).origin)
  } catch {
    return false
  }
}

function extensions(values: readonly string[] | undefined): void {
  if (values === undefined) return
  const unique = new Set(values)
  lchAssert(
    unique.size === values.length,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Critical identifiers repeat'
  )
  for (const value of values) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      lchAssert(false, 'ERR_LCH_PROFILE_UNSUPPORTED', 'Critical identifier is not absolute')
    }
    lchAssert(
      parsed.protocol.length > 1,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Critical identifier is not absolute'
    )
  }
}

function outputIndex(value: unknown): asserts value is number {
  lchAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'ERR_LCH_PAYMENT',
    'Payment output index is invalid'
  )
}

function equalId(value: LCHValue | undefined, expected: Uint8Array, name: string): void {
  lchAssert(
    value instanceof Uint8Array && toHex(value) === toHex(expected),
    'ERR_LCH_QUOTE',
    `${name} does not match`
  )
}

function selection(value: LCHValue | undefined): Selection {
  lchAssert(
    value !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_SELECTION',
    'Selection is invalid'
  )
  return normalizeSelection(value as unknown as Selection)
}
