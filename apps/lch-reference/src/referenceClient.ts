import { Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import {
  LCHMultipayBuyer,
  LCHReader,
  PublicBRC77Verifier,
  WalletBRC78KeyDelivery,
  objectId,
  toHex,
  validateOffer,
  type ContentSource,
  type AuthorizedOutputEvidence,
  type EndpointPolicy,
  type InspectedLCH,
  type LCHFundedMultipay,
  type LCHMultipayPlan,
  type SegmentedEncryptionDescriptor,
  type LCHTransactionState,
  type LCHValue,
  type SignedObject
} from '@bsv/lch'

export interface ReferenceAcquisitionPlan extends LCHMultipayPlan {
  bytes: Uint8Array
  inspected: InspectedLCH
  offer: SignedObject
  offerId: Uint8Array
}

export interface ReferenceAcquisitionResult {
  license: SignedObject
  licenseId: Uint8Array
  plaintext: Uint8Array
  receipts: SignedObject[]
  authorizedOutputs: AuthorizedOutputEvidence[]
  transactionId: string
  transactionState: LCHTransactionState
  recovered: boolean
}

export interface ReferencePendingPayment {
  requestId: string
  transactionId: string
  transactionState: LCHTransactionState
  settlementState: 'pending-settlement-proofs'
  receipts: number
  authorizedOutputs: number
  requiredProofs: number
  recoveryUntil: bigint
}

export class ReferenceLCHClient {
  private readonly reader: LCHReader
  private readonly multipay: Promise<LCHMultipayBuyer>
  private readonly now: () => bigint
  private recoveryState?: {
    requestId: string
    payment: LCHFundedMultipay
    receipts: Map<string, SignedObject>
    authorizedOutputs: Map<string, AuthorizedOutputEvidence>
  }

  constructor(
    private readonly wallet: WalletInterface,
    source: ContentSource,
    options: { endpointPolicy?: EndpointPolicy; now?: () => bigint } = {}
  ) {
    this.reader = new LCHReader(source)
    this.multipay = LCHMultipayBuyer.create(wallet, options)
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  }

  async prepare(bytes: Uint8Array): Promise<ReferenceAcquisitionPlan> {
    const inspected = await this.reader.inspect(bytes)
    await this.reader.resolve(inspected)
    const offer = inlineOffer(inspected.header.acquisition)
    const seller = memberBytes(offer.body, 'seller', 33)
    await validateOffer(offer, new PublicBRC77Verifier(), seller)
    equal(offer.body.assetId, inspected.assetId, 'Offer Asset ID')
    const offerId = await objectId('offer', offer.body)
    const payment = memberMap(offer.body, 'payment')
    const endpoint = memberString(payment, 'endpoint')
    const policy = memberMap(offer.body, 'policy')
    const multipay = await this.multipay
    const request = await multipay.createRequest({
      offerId,
      assetId: inspected.assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: memberBytes(policy, 'digest', 32),
      createdAt: this.now()
    })
    const issuer = memberBytes(offer.body, 'licenseIssuer', 33)
    const encryption = memberMap(inspected.representation, 'encryption')
    const keyDelivery = memberMap(offer.body, 'keyDelivery')
    const paymentPlan = await multipay.quote(endpoint, request, issuer, {
      type: 'segmented',
      encryption: encryption as unknown as SegmentedEncryptionDescriptor,
      delivery: memberString(keyDelivery, 'mechanism')
    })
    return {
      ...paymentPlan,
      bytes,
      inspected,
      offer,
      offerId
    }
  }

  async acquire(plan: ReferenceAcquisitionPlan): Promise<ReferenceAcquisitionResult> {
    const multipay = await this.multipay
    const requestId = toHex(plan.requestId)
    if (this.recoveryState !== undefined && this.recoveryState.requestId !== requestId)
      throw new Error('Another wallet transaction still requires delivery or License recovery')
    this.recoveryState ??= {
      requestId,
      payment: await multipay.createPayment(await multipay.refreshReadiness(plan)),
      receipts: new Map(),
      authorizedOutputs: new Map()
    }
    const {
      payment,
      receipts: recoveredReceipts,
      authorizedOutputs: recoveredAuthorizedOutputs
    } = this.recoveryState
    for (const delivery of payment.deliveries) {
      const demandId = toHex(delivery.demandId)
      if (recoveredReceipts.has(demandId) || recoveredAuthorizedOutputs.has(demandId)) continue
      const settlement = await multipay.settleDelivery(payment, delivery)
      if (settlement.type === 'receipt') recoveredReceipts.set(demandId, settlement.receipt)
      else recoveredAuthorizedOutputs.set(demandId, settlement.evidence)
    }
    const receipts = [...recoveredReceipts.values()]
    const authorizedOutputs = [...recoveredAuthorizedOutputs.values()]
    const license = await multipay.complete(payment, receipts, authorizedOutputs)
    equal(license.body.assetId, plan.inspected.assetId, 'License Asset ID')
    equal(license.body.offerId, plan.offerId, 'License Offer ID')

    const keys = new Map<string, Uint8Array>()
    const keyDelivery = new WalletBRC78KeyDelivery(this.wallet)
    for (const grant of mapArray(license.body.keyGrants, 'License key grants')) {
      const payload = memberBytes(grant, 'payload')
      const recovered = await keyDelivery.recover(payload)
      equal(grant.keyId, recovered.keyId, 'Recovered key ID')
      keys.set(toHex(recovered.keyId), recovered.cek)
    }
    const plaintext = await this.reader.decrypt(plan.inspected, keys)
    const licenseId = await objectId('license', license.body)
    const recovered = await multipay.recover(plan.endpoint, plan.requestId)
    if (
      recovered === undefined ||
      toHex(await objectId('license', recovered.body)) !== toHex(licenseId)
    )
      throw new Error('License recovery did not return the issued License')
    this.recoveryState = undefined
    return {
      license,
      licenseId,
      plaintext,
      receipts,
      authorizedOutputs,
      transactionId: Transaction.fromAtomicBEEF(payment.atomicBeef as AtomicBEEF).id('hex'),
      transactionState: authorizedOutputs.length > 0 ? 'accepted' : payment.transactionState,
      recovered: true
    }
  }

  hasPendingPayment(): boolean {
    return this.recoveryState !== undefined
  }

  pendingPayment(): ReferencePendingPayment | undefined {
    const state = this.recoveryState
    if (state === undefined) return undefined
    const transaction = Transaction.fromAtomicBEEF(state.payment.atomicBeef as AtomicBEEF)
    return {
      requestId: state.requestId,
      transactionId: transaction.id('hex'),
      transactionState:
        state.authorizedOutputs.size > 0 ? 'accepted' : state.payment.transactionState,
      settlementState: 'pending-settlement-proofs',
      receipts: state.receipts.size,
      authorizedOutputs: state.authorizedOutputs.size,
      requiredProofs: state.payment.deliveries.length,
      recoveryUntil: state.payment.plan.recoveryUntil
    }
  }
}

function inlineOffer(value: LCHValue | undefined): SignedObject {
  if (!Array.isArray(value)) throw new Error('Header acquisition entries are invalid')
  for (const entry of value) {
    if (isMap(entry) && entry.mode === 'inline') return signed(entry.offer)
  }
  throw new Error('Reference client requires an inline Offer')
}

function signed(value: LCHValue | undefined): SignedObject {
  const map = asMap(value, 'Signed Object')
  if (!Array.isArray(map.signatures) || !map.signatures.every(item => item instanceof Uint8Array))
    throw new Error('Signed Object signatures are invalid')
  return {
    body: asMap(map.body, 'Signed Object body'),
    signatures: map.signatures as Uint8Array[]
  }
}

function memberMap(body: Record<string, LCHValue>, key: string): Record<string, LCHValue> {
  return asMap(body[key], key)
}

function mapArray(value: LCHValue | undefined, name: string): Array<Record<string, LCHValue>> {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map(item => asMap(item, name))
}

function asMap(value: LCHValue | undefined, name: string): Record<string, LCHValue> {
  if (!isMap(value)) throw new Error(`${name} is invalid`)
  return value
}

function isMap(value: LCHValue | undefined): value is Record<string, LCHValue> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  )
}

function memberBytes(body: Record<string, LCHValue>, key: string, length?: number): Uint8Array {
  const value = body[key]
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length))
    throw new Error(`${key} is invalid`)
  return value
}

function memberString(body: Record<string, LCHValue>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is invalid`)
  return value
}

function equal(value: LCHValue | undefined, expected: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || toHex(value) !== toHex(expected))
    throw new Error(`${name} does not match`)
}
