import PublicKey from '@bsv/sdk/primitives/PublicKey'
import P2PKH from '@bsv/sdk/script/templates/P2PKH'
import Transaction from '@bsv/sdk/transaction/Transaction'
import type { AtomicBEEF, WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import {
  LCHBuyer,
  validateLicenseRequest,
  validatePaymentDelivery,
  validatePaymentDemand,
  validatePaymentReceipt,
  validatePaymentReadiness,
  validateQuote,
  type AcquisitionValidationOptions,
  type LicenseRequestOptions,
  type PaymentCompletion
} from './acquisition.js'
import { LCHHttpAcquisitionClient, type LCHHttpClientOptions } from './http.js'
import { validateEncryptionDescriptor, validateKeyGrantsForSelection } from './encryption.js'
import { fromHex, objectId, toBase64Url, toHex } from './hash.js'
import { LCH_LIMITS, LCH_SETTLEMENT_PROFILES } from './constants.js'
import { encodeDeterministicCbor } from './cbor.js'
import { lchAssert } from './errors.js'
import { validatePolicyReference, type PolicyReference } from './policy.js'
import { normalizeSelection, validateNormalizedSelection } from './selection.js'
import { BRC29_PAYMENT_PROTOCOL, createMultipayTransaction } from './walletPayment.js'
import { PublicBRC77Verifier, WalletBRC77Signer } from './signatures.js'
import { verifySignedObject } from './objects.js'
import { validateOffer } from './core.js'
import { validateTimeWindow } from './time.js'
import {
  validateAuthorizedOutputEvidence,
  validateDeliveryAcknowledgement,
  validatePaymentAuthorization,
  validateTransactionEvidence,
  type AuthorizedOutputEvidence
} from './settlement.js'
import type {
  KeyGrant,
  LCHSigner,
  LCHTransactionState,
  LCHValue,
  SegmentedEncryptionDescriptor,
  Selection,
  SignedObject,
  UnverifiedLicenseResponse
} from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotLCHRecord,
  snapshotSignedObject,
  snapshotStringArray,
  snapshotStringSet
} from './boundary.js'

export type LCHLicenseKeyGrantExpectation =
  | { type: 'none' }
  | {
      type: 'segmented'
      encryption: SegmentedEncryptionDescriptor
      delivery: string
    }

export interface LCHMultipayPlan {
  offer: SignedObject
  seller: Uint8Array
  request: SignedObject
  requestId: Uint8Array
  quote: SignedObject
  demands: SignedObject[]
  readiness: SignedObject[]
  authorizations: SignedObject[]
  issuer: Uint8Array
  endpoint: string
  totalSatoshis: bigint
  expiresAt: bigint
  recoveryUntil: bigint
  keyGrants: LCHLicenseKeyGrantExpectation
}

export interface LCHMultipayDelivery {
  demandId: Uint8Array
  payee: Uint8Array
  endpoint: string
  delivery: SignedObject
}

export type LCHMultipaySettlement =
  | { type: 'receipt'; receipt: SignedObject }
  | { type: 'authorized-output'; evidence: AuthorizedOutputEvidence }

export interface LCHFundedMultipay {
  plan: LCHMultipayPlan
  atomicBeef: Uint8Array
  deliveries: LCHMultipayDelivery[]
  transactionState: Extract<LCHTransactionState, 'finalized'>
}

export interface LCHAgreementEvaluationContext {
  offer: Readonly<SignedObject>
  request: Readonly<SignedObject>
  quote: Readonly<SignedObject>
  license: Readonly<SignedObject>
  offerPolicy: Readonly<PolicyReference>
  agreement: Readonly<PolicyReference>
}

/**
 * Application-supplied, profile-aware ODRL decision.
 *
 * Return true only when the signed License Agreement preserves every accepted
 * Offer term for the requested action and selection, including prohibitions,
 * constraints, and duties under the application's supported ODRL profile.
 */
export type LCHAgreementEvaluator = (
  context: LCHAgreementEvaluationContext
) => boolean | Promise<boolean>

export interface LCHMultipayBuyerOptions extends LCHHttpClientOptions {
  /** Required before a recovered or completed License can be accepted. */
  agreementEvaluator?: LCHAgreementEvaluator
  now?: () => bigint
  transport?: LCHAcquisitionTransport
  supportedCriticalIdentifiers?: ReadonlySet<string>
}

/**
 * Transport boundary for acquisition coordination.
 *
 * The signed Offer endpoint and every signed Payment Demand endpoint are
 * independent destinations. HTTP is the default BRC-170 binding, while an
 * application can supply a message-box or other registered binding without
 * changing the signed objects or the recovery-safe payment workflow.
 */
export interface LCHAcquisitionTransport {
  preflightLicense(endpoint: string, request: SignedObject): Promise<void>
  quote(endpoint: string, request: SignedObject): Promise<SignedObject>
  preflightDemand(endpoint: string, demand: SignedObject): Promise<SignedObject>
  authorizePayment(endpoint: string, demand: SignedObject): Promise<SignedObject>
  deliver(endpoint: string, delivery: SignedObject): Promise<SignedObject>
  storeDelivery(
    endpoint: string,
    authorization: SignedObject,
    delivery: SignedObject
  ): Promise<SignedObject>
  attestTransaction(
    endpoint: string,
    authorization: SignedObject,
    atomicBeef: Uint8Array
  ): Promise<SignedObject>
  complete(endpoint: string, completion: PaymentCompletion): Promise<SignedObject>
  recoverUnverified?(
    endpoint: string,
    requestId: Uint8Array
  ): Promise<UnverifiedLicenseResponse | undefined>
  /** @deprecated Implement recoverUnverified. Legacy results are wrapped as unverified. */
  recover?(
    endpoint: string,
    requestId: Uint8Array
  ): Promise<SignedObject | UnverifiedLicenseResponse | undefined>
}

/** A complete non-custodial BRC-170 multipay buyer workflow. */
export class LCHMultipayBuyer {
  private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'createAction'>
  private readonly signer: LCHSigner
  private readonly buyer: LCHBuyer
  private readonly transport: LCHAcquisitionTransport
  private readonly now: () => bigint
  private readonly validationOptions: AcquisitionValidationOptions
  private readonly agreementEvaluator?: LCHAgreementEvaluator

  constructor(
    wallet: Pick<WalletInterface, 'getPublicKey' | 'createAction'>,
    signer: LCHSigner,
    options: LCHMultipayBuyerOptions = {}
  ) {
    lchAssert(options !== null && typeof options === 'object', 'ERR_LCH_POLICY', 'Invalid options')
    const agreementEvaluator = ownDataValue(options, 'agreementEvaluator', 'Multipay Buyer options')
    const transport = ownDataValue(options, 'transport', 'Multipay Buyer options')
    const now = ownDataValue(options, 'now', 'Multipay Buyer options')
    lchAssert(
      agreementEvaluator === undefined || typeof agreementEvaluator === 'function',
      'ERR_LCH_POLICY',
      'The License Agreement evaluator must be a function'
    )
    lchAssert(
      transport === undefined || (transport !== null && typeof transport === 'object'),
      'ERR_LCH_DELIVERY',
      'The acquisition transport is invalid'
    )
    lchAssert(
      now === undefined || typeof now === 'function',
      'ERR_LCH_PAYMENT',
      'Buyer clock is invalid'
    )
    this.wallet = wallet
    this.signer = signer
    this.buyer = new LCHBuyer(signer)
    this.transport =
      (transport as LCHAcquisitionTransport | undefined) ?? new LCHHttpAcquisitionClient(options)
    this.now = (now as (() => bigint) | undefined) ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.agreementEvaluator = agreementEvaluator as LCHAgreementEvaluator | undefined
    const endpointPolicy = ownDataValue(options, 'endpointPolicy', 'Multipay Buyer options')
    const allowLocalOrigins =
      endpointPolicy === undefined
        ? undefined
        : snapshotStringArray(
            ownDataValue(endpointPolicy, 'allowLocalOrigins', 'Endpoint policy'),
            'Endpoint policy allowLocalOrigins'
          )
    this.validationOptions = {
      allowInsecureLocalOrigins: allowLocalOrigins ?? [],
      supportedCriticalIdentifiers: snapshotStringSet(
        ownDataValue(options, 'supportedCriticalIdentifiers', 'Multipay Buyer options'),
        'Multipay Buyer supportedCriticalIdentifiers'
      )
    }
  }

  static async create(
    wallet: WalletInterface,
    options: LCHMultipayBuyerOptions = {}
  ): Promise<LCHMultipayBuyer> {
    return new LCHMultipayBuyer(wallet, await WalletBRC77Signer.create({ wallet }), options)
  }

  createRequest(options: LicenseRequestOptions): Promise<SignedObject> {
    return this.buyer.createRequest(options)
  }

  async quote(
    offer: SignedObject,
    request: SignedObject,
    seller: Uint8Array,
    keyGrants: LCHLicenseKeyGrantExpectation
  ): Promise<LCHMultipayPlan> {
    lchAssert(
      offer !== null && typeof offer === 'object' && !Array.isArray(offer),
      'ERR_LCH_POLICY',
      'A signed Offer is required; endpoint-only quote calls are not supported in 0.2'
    )
    offer = snapshotSignedObject(offer, 'Offer')
    request = snapshotSignedObject(request, 'License Request')
    seller = snapshotBytes(seller, 'Offer seller')
    keyGrants = snapshotLCHRecord(
      keyGrants,
      'License key-grant expectation'
    ) as unknown as LCHLicenseKeyGrantExpectation
    validateKeyGrantExpectation(keyGrants)
    await validateOffer(offer, new PublicBRC77Verifier(), seller, this.validationOptions)
    const offerId = await objectId('offer', offer.body)
    equal(request.body.offerId, offerId, 'License Request Offer ID')
    equal(request.body.assetId, memberBytes(offer.body, 'assetId', 32), 'License Request Asset ID')
    const offerPolicy = await validatePolicyReference(mapValue(offer.body.policy, 'Offer Policy'))
    equal(
      request.body.acceptedPolicyDigest,
      offerPolicy.digest,
      'License Request accepted Policy digest'
    )
    const payment = mapValue(offer.body.payment, 'Offer Payment')
    const endpoint = memberString(payment, 'endpoint')
    const issuer = memberBytes(offer.body, 'licenseIssuer', 33)
    const requestId = await validateLicenseRequest(request, undefined, this.validationOptions)
    equal(request.body.buyer, this.signer.identityKey, 'License Request buyer')
    await this.transport.preflightLicense(
      endpoint,
      snapshotSignedObject(request, 'License Request')
    )
    const quote = snapshotSignedObject(
      await this.transport.quote(endpoint, snapshotSignedObject(request, 'License Request')),
      'Quote'
    )
    await validateQuote(quote, request, issuer, undefined, this.validationOptions)
    const demands = signedArray(quote.body.demands)
    const readiness = await this.obtainReadiness(demands)
    const authorizations = await this.obtainAuthorizations(demands)
    let totalSatoshis = 0n
    for (const demand of demands) {
      await validatePaymentDemand(demand, undefined, this.validationOptions)
      equal(demand.body.requestId, requestId, 'Demand Request ID')
      totalSatoshis += uint(demand.body.satoshis, 'Demand amount')
    }
    if (totalSatoshis !== uint(quote.body.totalSatoshis, 'Quote total'))
      throw new Error('Quote total does not equal its Payment Demands')
    return {
      offer,
      seller,
      request,
      requestId,
      quote,
      demands,
      readiness,
      authorizations,
      issuer,
      endpoint,
      totalSatoshis,
      expiresAt: uint(quote.body.expiresAt, 'Quote expiry'),
      recoveryUntil: uint(quote.body.recoveryUntil, 'Quote recovery deadline'),
      keyGrants
    }
  }

  async createPayment(plan: LCHMultipayPlan): Promise<LCHFundedMultipay> {
    plan = snapshotLCHRecord(plan, 'Multipay plan') as unknown as LCHMultipayPlan
    const now = this.now()
    if (now >= plan.expiresAt)
      throw new Error('The signed Quote expired before transaction creation')
    await this.validatePlanIntegrity(plan)
    await this.validatePlanReadiness(plan.demands, plan.readiness, now)
    const authorizationByDemand = await this.validatePlanAuthorizations(
      plan.demands,
      plan.authorizations,
      now
    )
    const demands = await Promise.all(
      plan.demands.map(async demand => ({
        demand,
        demandId: await objectId('payment-demand', demand.body),
        payee: memberBytes(demand.body, 'payee', 33),
        satoshis: uint(demand.body.satoshis, 'Demand amount'),
        derivationPrefix: memberBytes(demand.body, 'derivationPrefix', 32),
        dutyUid: memberString(demand.body, 'dutyUid'),
        authorization: authorizationByDemand.get(
          toHex(await objectId('payment-demand', demand.body))
        )
      }))
    )
    const payment = await createMultipayTransaction(
      this.wallet,
      demands.map(({ demand: _demand, authorization, ...item }) => ({
        ...item,
        ...(authorization === undefined
          ? {}
          : {
              authorizedOutput: {
                derivationSuffix: memberBytes(authorization.body, 'derivationSuffix', 32),
                lockingScript: memberBytesAny(authorization.body, 'lockingScript')
              }
            })
      }))
    )
    const deliveries: LCHMultipayDelivery[] = []
    for (const remittance of payment.remittances) {
      const item = demands.find(demand => toHex(demand.demandId) === toHex(remittance.demandId))
      if (item === undefined) throw new Error('Wallet returned an unknown remittance')
      const delivery = await this.buyer.createPaymentDelivery({
        demandId: item.demandId,
        requestId: plan.requestId,
        atomicBeef: payment.atomicBeef,
        outputIndex: remittance.outputIndex,
        derivationPrefix: remittance.derivationPrefix,
        derivationSuffix: remittance.derivationSuffix
      })
      deliveries.push({
        demandId: item.demandId,
        payee: item.payee,
        endpoint: memberString(item.demand.body, 'endpoint'),
        delivery
      })
    }
    return {
      plan,
      atomicBeef: payment.atomicBeef,
      deliveries,
      transactionState: payment.transactionState
    }
  }

  async refreshReadiness(plan: LCHMultipayPlan): Promise<LCHMultipayPlan> {
    plan = snapshotLCHRecord(plan, 'Multipay plan') as unknown as LCHMultipayPlan
    await this.validatePlanIntegrity(plan)
    if (this.now() >= plan.expiresAt)
      throw new Error('The signed Quote expired before readiness refresh')
    return { ...plan, readiness: await this.obtainReadiness(plan.demands) }
  }

  async deliver(payment: LCHFundedMultipay, item: LCHMultipayDelivery): Promise<SignedObject> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    item = snapshotLCHRecord(item, 'Multipay Delivery') as unknown as LCHMultipayDelivery
    await this.validateFundedPayment(payment, item)
    const receipt = snapshotSignedObject(
      await this.transport.deliver(
        item.endpoint,
        snapshotSignedObject(item.delivery, 'Payment Delivery')
      ),
      'Payment Receipt'
    )
    await this.validateReceipt(payment, item, receipt)
    return receipt
  }

  private async validateReceipt(
    payment: LCHFundedMultipay,
    item: LCHMultipayDelivery,
    receipt: SignedObject
  ): Promise<void> {
    receipt = snapshotSignedObject(receipt, 'Payment Receipt')
    await validatePaymentReceipt(receipt, undefined, this.validationOptions)
    equal(receipt.body.demandId, item.demandId, 'Receipt Demand ID')
    equal(receipt.body.requestId, payment.plan.requestId, 'Receipt Request ID')
    equal(receipt.body.payee, item.payee, 'Receipt Payee')
    const transaction = Transaction.fromAtomicBEEF(payment.atomicBeef as AtomicBEEF)
    equal(receipt.body.txid, fromHex(transaction.id('hex')), 'Receipt transaction ID')
    if (
      uint(receipt.body.outputIndex, 'Receipt output index') !==
      uint(item.delivery.body.outputIndex, 'Delivery output index')
    )
      throw new Error('Receipt output index does not match the Payment Delivery')
    const demand = await demandById(payment.plan.demands, item.demandId)
    if (
      uint(receipt.body.satoshis, 'Receipt amount') !== uint(demand.body.satoshis, 'Demand amount')
    )
      throw new Error('Receipt amount does not match the Payment Demand')
  }

  private async settlementContext(
    payment: LCHFundedMultipay,
    receipts: readonly SignedObject[],
    authorizedOutputs: readonly AuthorizedOutputEvidence[]
  ): Promise<{
    completion: PaymentCompletion
    expectedFulfillments: Array<Record<string, LCHValue>>
  }> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    receipts = receipts.map((receipt, index) =>
      snapshotSignedObject(receipt, `Payment Receipt ${index}`)
    )
    authorizedOutputs = authorizedOutputs.map((evidence, index) =>
      snapshotAuthorizedOutputEvidence(evidence, index)
    )
    await this.validateFundedPayment(payment)
    if (receipts.length + authorizedOutputs.length !== payment.deliveries.length)
      throw new Error(
        authorizedOutputs.length === 0
          ? 'Payment Completion requires one Receipt per Delivery'
          : 'Payment Completion requires one settlement proof per Delivery'
      )
    const expected = new Map(
      payment.deliveries.map(delivery => [toHex(delivery.demandId), delivery] as const)
    )
    const seen = new Set<string>()
    const expectedFulfillments: Array<Record<string, LCHValue>> = []
    for (const receipt of receipts) {
      const demandId = memberBytes(receipt.body, 'demandId', 32)
      const demandIdHex = toHex(demandId)
      const delivery = expected.get(demandIdHex)
      if (delivery === undefined || seen.has(demandIdHex))
        throw new Error('Payment Completion has an unexpected or repeated Receipt')
      await this.validateReceipt(payment, delivery, receipt)
      const demand = await demandById(payment.plan.demands, demandId)
      expectedFulfillments.push({
        dutyUid: memberString(demand.body, 'dutyUid'),
        settlementProfile: memberString(demand.body, 'settlementProfile'),
        receiptIds: [await objectId('payment-receipt', receipt.body)]
      })
      seen.add(demandIdHex)
    }
    for (const bundle of authorizedOutputs) {
      const demandId = memberBytes(bundle.authorization.body, 'demandId', 32)
      const demandIdHex = toHex(demandId)
      const delivery = expected.get(demandIdHex)
      if (delivery === undefined || seen.has(demandIdHex))
        throw new Error('Payment Completion has an unexpected or repeated authorized output')
      const demand = await demandById(payment.plan.demands, demandId)
      if (demand.body.settlementProfile !== LCH_SETTLEMENT_PROFILES.authorizedOutput)
        throw new Error('Payment Demand does not permit authorized-output settlement')
      await validateAuthorizedOutputEvidence(
        bundle,
        demand,
        payment.atomicBeef,
        new PublicBRC77Verifier(),
        this.validationOptions
      )
      expectedFulfillments.push({
        dutyUid: memberString(demand.body, 'dutyUid'),
        settlementProfile: memberString(demand.body, 'settlementProfile'),
        authorizationId: await objectId('payment-authorization', bundle.authorization.body),
        transactionEvidenceId: await objectId(
          'transaction-evidence',
          bundle.transactionEvidence.body
        ),
        deliveryAcknowledgementId: await objectId(
          'payment-delivery-ack',
          bundle.deliveryAcknowledgement.body
        )
      })
      seen.add(demandIdHex)
    }
    return {
      completion: {
        request: payment.plan.request,
        quote: payment.plan.quote,
        atomicBeef: payment.atomicBeef,
        receipts: [...receipts],
        authorizedOutputs: [...authorizedOutputs]
      },
      expectedFulfillments
    }
  }

  async complete(
    payment: LCHFundedMultipay,
    receipts: readonly SignedObject[],
    authorizedOutputs: readonly AuthorizedOutputEvidence[] = []
  ): Promise<SignedObject> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    const { completion, expectedFulfillments } = await this.settlementContext(
      payment,
      receipts,
      authorizedOutputs
    )
    const license = await this.transport.complete(payment.plan.endpoint, completion)
    const ownedLicense = snapshotSignedObject(license, 'License')
    await this.validateLicense(payment, ownedLicense, expectedFulfillments)
    return ownedLicense
  }

  private async validateLicense(
    payment: LCHFundedMultipay,
    license: SignedObject,
    expectedFulfillments: readonly Record<string, LCHValue>[]
  ): Promise<void> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    expectedFulfillments = expectedFulfillments.map(fulfillment =>
      snapshotLCHRecord(fulfillment, 'Expected License fulfillment')
    )
    license = snapshotSignedObject(license, 'License')
    await verifySignedObject(
      'license',
      license,
      new PublicBRC77Verifier(),
      payment.plan.issuer,
      this.validationOptions
    )
    lchAssert(license.body.version === 1, 'ERR_LCH_LICENSE', 'License version is unsupported')
    uint(license.body.issuedAt, 'License issuance time')
    validateTimeWindow({
      ...(license.body.notBefore === undefined
        ? {}
        : { notBefore: uint(license.body.notBefore, 'License notBefore') }),
      ...(license.body.notAfter === undefined
        ? {}
        : { notAfter: uint(license.body.notAfter, 'License notAfter') })
    })
    const agreement = await validatePolicyReference(
      mapValue(license.body.agreement, 'License Agreement')
    )
    equal(
      license.body.assetId,
      memberBytes(payment.plan.request.body, 'assetId', 32),
      'License Asset ID'
    )
    equal(
      license.body.assetId,
      memberBytes(payment.plan.quote.body, 'assetId', 32),
      'License Asset ID'
    )
    equal(
      license.body.offerId,
      memberBytes(payment.plan.request.body, 'offerId', 32),
      'License Offer ID'
    )
    equal(
      license.body.offerId,
      memberBytes(payment.plan.quote.body, 'offerId', 32),
      'License Offer ID'
    )
    equal(license.body.requestId, payment.plan.requestId, 'License Request ID')
    equal(license.body.issuer, payment.plan.issuer, 'License issuer')
    equal(
      license.body.subject,
      memberBytes(payment.plan.request.body, 'buyer', 33),
      'License subject'
    )
    equal(license.body.subject, this.signer.identityKey, 'License subject')
    equalLCHValue(
      normalizedSelectionValue(license.body.selection, 'License Selection'),
      normalizedSelectionValue(payment.plan.request.body.selection, 'License Request Selection'),
      'License Selection'
    )
    equalLCHValue(
      normalizedSelectionValue(license.body.selection, 'License Selection'),
      normalizedSelectionValue(payment.plan.quote.body.selection, 'Quote Selection'),
      'License Selection'
    )
    equalOptionalSelection(
      license.body.segmentSelection,
      payment.plan.quote.body.segmentSelection,
      'License segment Selection'
    )
    validateFulfillments(license.body.fulfillments, expectedFulfillments)
    validateLicenseKeyGrants(
      license.body.keyGrants,
      license.body.segmentSelection ?? license.body.selection,
      payment.plan.keyGrants
    )
    const offerPolicy = await validatePolicyReference(
      mapValue(payment.plan.offer.body.policy, 'Offer Policy')
    )
    lchAssert(
      typeof this.agreementEvaluator === 'function',
      'ERR_LCH_POLICY',
      'A profile-aware License Agreement evaluator is required before accepting a License'
    )
    const accepted = await this.agreementEvaluator({
      offer: snapshotSignedObject(payment.plan.offer, 'Offer'),
      request: snapshotSignedObject(payment.plan.request, 'License Request'),
      quote: snapshotSignedObject(payment.plan.quote, 'Quote'),
      license: snapshotSignedObject(license, 'License'),
      offerPolicy: snapshotLCHRecord(offerPolicy, 'Offer Policy') as unknown as PolicyReference,
      agreement: snapshotLCHRecord(agreement, 'License Agreement') as unknown as PolicyReference
    })
    lchAssert(
      accepted === true,
      'ERR_LCH_POLICY',
      'License Agreement was not accepted by the configured policy evaluator'
    )
  }

  /**
   * Recovers and validates a License against the complete funded acquisition.
   */
  async recover(
    payment: LCHFundedMultipay,
    receipts: readonly SignedObject[],
    authorizedOutputs: readonly AuthorizedOutputEvidence[] = []
  ): Promise<SignedObject | undefined> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    const { expectedFulfillments } = await this.settlementContext(
      payment,
      receipts,
      authorizedOutputs
    )
    const response = await this.recoverUnverified(payment.plan.endpoint, payment.plan.requestId)
    if (response === undefined) return undefined
    const license = snapshotSignedObject(response.unverifiedLicense, 'Recovered License')
    await this.validateLicense(payment, license, expectedFulfillments)
    return license
  }

  private async recoverUnverified(
    endpoint: string,
    requestId: Uint8Array
  ): Promise<UnverifiedLicenseResponse | undefined> {
    if (typeof this.transport.recoverUnverified === 'function') {
      const response = await this.transport.recoverUnverified(endpoint, requestId.slice())
      if (response === undefined) return undefined
      return {
        unverifiedLicense: snapshotSignedObject(
          requiredOwnDataValue(response, 'unverifiedLicense', 'License recovery result'),
          'Recovered License'
        )
      }
    }
    lchAssert(
      typeof this.transport.recover === 'function',
      'ERR_LCH_LICENSE',
      'The acquisition transport does not support License recovery'
    )
    const legacy = await this.transport.recover(endpoint, requestId.slice())
    if (legacy === undefined) return undefined
    const wrapped = ownDataValue(legacy, 'unverifiedLicense', 'License recovery result')
    return {
      unverifiedLicense: snapshotSignedObject(
        wrapped === undefined ? legacy : wrapped,
        'Recovered License'
      )
    }
  }

  async collectAuthorizedOutputEvidence(
    payment: LCHFundedMultipay,
    item: LCHMultipayDelivery
  ): Promise<AuthorizedOutputEvidence> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    item = snapshotLCHRecord(item, 'Multipay Delivery') as unknown as LCHMultipayDelivery
    await this.validateFundedPayment(payment, item)
    const demand = await demandById(payment.plan.demands, item.demandId)
    const authorization = payment.plan.authorizations.find(
      candidate => toHex(memberBytes(candidate.body, 'demandId', 32)) === toHex(item.demandId)
    )
    if (authorization === undefined)
      throw new Error('Payment plan has no Authorization for this Delivery')
    await validatePaymentAuthorization(
      authorization,
      demand,
      undefined,
      new PublicBRC77Verifier(),
      this.validationOptions
    )
    const deliveryAcknowledgement = snapshotSignedObject(
      await this.transport.storeDelivery(
        memberString(authorization.body, 'deliveryEndpoint'),
        snapshotSignedObject(authorization, 'Payment Authorization'),
        snapshotSignedObject(item.delivery, 'Payment Delivery')
      ),
      'Payment Delivery Acknowledgement'
    )
    await validateDeliveryAcknowledgement(
      deliveryAcknowledgement,
      authorization,
      item.delivery,
      await objectId('payment-authorization', authorization.body),
      await objectId('payment-delivery', item.delivery.body),
      new PublicBRC77Verifier(),
      this.validationOptions
    )
    const transactionEvidence = snapshotSignedObject(
      await this.transport.attestTransaction(
        memberString(authorization.body, 'evidenceEndpoint'),
        snapshotSignedObject(authorization, 'Payment Authorization'),
        payment.atomicBeef.slice()
      ),
      'Transaction Evidence'
    )
    await validateTransactionEvidence(
      transactionEvidence,
      authorization,
      await objectId('payment-authorization', authorization.body),
      Transaction.fromAtomicBEEF(payment.atomicBeef as AtomicBEEF),
      new PublicBRC77Verifier(),
      this.validationOptions
    )
    const bundle = {
      authorization,
      delivery: item.delivery,
      transactionEvidence,
      deliveryAcknowledgement
    }
    await validateAuthorizedOutputEvidence(
      bundle,
      demand,
      payment.atomicBeef,
      new PublicBRC77Verifier(),
      this.validationOptions
    )
    return bundle
  }

  async settleDelivery(
    payment: LCHFundedMultipay,
    item: LCHMultipayDelivery
  ): Promise<LCHMultipaySettlement> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    item = snapshotLCHRecord(item, 'Multipay Delivery') as unknown as LCHMultipayDelivery
    await this.validateFundedPayment(payment, item)
    let receipt: SignedObject
    try {
      receipt = snapshotSignedObject(
        await this.transport.deliver(
          item.endpoint,
          snapshotSignedObject(item.delivery, 'Payment Delivery')
        ),
        'Payment Receipt'
      )
    } catch (error) {
      const demand = await demandById(payment.plan.demands, item.demandId)
      if (demand.body.settlementProfile !== LCH_SETTLEMENT_PROFILES.authorizedOutput) throw error
      return {
        type: 'authorized-output',
        evidence: await this.collectAuthorizedOutputEvidence(payment, item)
      }
    }
    await this.validateReceipt(payment, item, receipt)
    return { type: 'receipt', receipt }
  }

  private async obtainReadiness(demands: readonly SignedObject[]): Promise<SignedObject[]> {
    const readiness: SignedObject[] = []
    for (const demand of demands) {
      const ready = snapshotSignedObject(
        await this.transport.preflightDemand(
          memberString(demand.body, 'endpoint'),
          snapshotSignedObject(demand, 'Payment Demand')
        ),
        'Payment Readiness'
      )
      await validatePaymentReadiness(
        ready,
        demand,
        this.now(),
        new PublicBRC77Verifier(),
        this.validationOptions
      )
      readiness.push(ready)
    }
    return readiness
  }

  private async obtainAuthorizations(demands: readonly SignedObject[]): Promise<SignedObject[]> {
    const authorizations: SignedObject[] = []
    for (const demand of demands) {
      if (demand.body.settlementProfile !== LCH_SETTLEMENT_PROFILES.authorizedOutput) continue
      const authorization = snapshotSignedObject(
        await this.transport.authorizePayment(
          memberString(demand.body, 'endpoint'),
          snapshotSignedObject(demand, 'Payment Demand')
        ),
        'Payment Authorization'
      )
      await validatePaymentAuthorization(
        authorization,
        demand,
        this.now(),
        new PublicBRC77Verifier(),
        this.validationOptions
      )
      authorizations.push(authorization)
    }
    return authorizations
  }

  private async validatePlanAuthorizations(
    demands: readonly SignedObject[],
    authorizations: readonly SignedObject[],
    now: bigint
  ): Promise<Map<string, SignedObject>> {
    const available = new Map(
      authorizations.map(item => [toHex(memberBytes(item.body, 'demandId', 32)), item] as const)
    )
    if (available.size !== authorizations.length)
      throw new Error('Payment plan has a repeated Authorization')
    for (const demand of demands) {
      const demandId = await objectId('payment-demand', demand.body)
      const demandIdHex = toHex(demandId)
      const authorization = available.get(demandIdHex)
      if (demand.body.settlementProfile === LCH_SETTLEMENT_PROFILES.authorizedOutput) {
        if (authorization === undefined)
          throw new Error('Payment plan is missing a required Payment Authorization')
        await validatePaymentAuthorization(
          authorization,
          demand,
          now,
          new PublicBRC77Verifier(),
          this.validationOptions
        )
      } else if (authorization !== undefined) {
        throw new Error('Payment plan has an Authorization for a receipt-only Demand')
      }
    }
    return available
  }

  private async validatePlanReadiness(
    demands: readonly SignedObject[],
    readiness: readonly SignedObject[],
    now: bigint
  ): Promise<void> {
    if (readiness.length !== demands.length)
      throw new Error('Payment plan requires one current Readiness per Demand')
    const available = new Map(
      readiness.map(item => [toHex(memberBytes(item.body, 'demandId', 32)), item] as const)
    )
    if (available.size !== readiness.length)
      throw new Error('Payment plan has a repeated Readiness')
    for (const demand of demands) {
      const demandId = await objectId('payment-demand', demand.body)
      const ready = available.get(toHex(demandId))
      if (ready === undefined) throw new Error('Payment plan is missing a Demand Readiness')
      await validatePaymentReadiness(
        ready,
        demand,
        now,
        new PublicBRC77Verifier(),
        this.validationOptions
      )
    }
  }

  private async validatePlanIntegrity(plan: LCHMultipayPlan): Promise<void> {
    plan = snapshotLCHRecord(plan, 'Multipay plan') as unknown as LCHMultipayPlan
    lchAssert(
      plan !== null && typeof plan === 'object',
      'ERR_LCH_PAYMENT',
      'Payment plan is invalid'
    )
    validateKeyGrantExpectation(plan.keyGrants)
    const seller = memberBytesValue(plan.seller, 33, 'Payment plan seller')
    await validateOffer(plan.offer, new PublicBRC77Verifier(), seller, this.validationOptions)
    const offerId = await objectId('offer', plan.offer.body)
    const offerAssetId = memberBytes(plan.offer.body, 'assetId', 32)
    const offerPolicy = await validatePolicyReference(
      mapValue(plan.offer.body.policy, 'Offer Policy')
    )
    equal(plan.request.body.offerId, offerId, 'Payment plan Offer ID')
    equal(plan.request.body.assetId, offerAssetId, 'Payment plan Asset ID')
    equal(
      plan.request.body.acceptedPolicyDigest,
      offerPolicy.digest,
      'Payment plan accepted Policy digest'
    )
    const offerPayment = mapValue(plan.offer.body.payment, 'Offer Payment')
    lchAssert(
      plan.endpoint === memberString(offerPayment, 'endpoint'),
      'ERR_LCH_ENDPOINT',
      'Payment plan endpoint does not match the signed Offer'
    )
    equal(plan.offer.body.licenseIssuer, plan.issuer, 'Payment plan License issuer')
    const keyDelivery = mapValue(plan.offer.body.keyDelivery, 'Offer key delivery')
    if (plan.keyGrants.type === 'segmented') {
      lchAssert(
        plan.keyGrants.delivery === memberString(keyDelivery, 'mechanism'),
        'ERR_LCH_KEY',
        'Payment plan key delivery does not match the signed Offer'
      )
    }
    const requestId = await validateLicenseRequest(plan.request, undefined, this.validationOptions)
    equal(requestId, plan.requestId, 'Payment plan Request ID')
    equal(plan.request.body.buyer, this.signer.identityKey, 'Payment plan buyer')
    await validateQuote(
      plan.quote,
      plan.request,
      memberBytesValue(plan.issuer, 33, 'Payment plan issuer'),
      undefined,
      this.validationOptions
    )
    const quotedDemands = signedArray(plan.quote.body.demands, 1)
    lchAssert(
      Array.isArray(plan.demands) &&
        toHex(encodeDeterministicCbor(quotedDemands as unknown as LCHValue)) ===
          toHex(encodeDeterministicCbor(plan.demands as unknown as LCHValue)),
      'ERR_LCH_PAYMENT',
      'Payment plan Demands do not match the signed Quote'
    )
    lchAssert(
      uint(plan.totalSatoshis as unknown as LCHValue, 'Payment plan total') ===
        uint(plan.quote.body.totalSatoshis, 'Quote total') &&
        uint(plan.expiresAt as unknown as LCHValue, 'Payment plan expiry') ===
          uint(plan.quote.body.expiresAt, 'Quote expiry') &&
        uint(plan.recoveryUntil as unknown as LCHValue, 'Payment plan recovery deadline') ===
          uint(plan.quote.body.recoveryUntil, 'Quote recovery deadline'),
      'ERR_LCH_PAYMENT',
      'Payment plan totals or deadlines do not match the signed Quote'
    )
  }

  private async validateFundedPayment(
    payment: LCHFundedMultipay,
    selectedDelivery?: LCHMultipayDelivery
  ): Promise<void> {
    payment = snapshotLCHRecord(payment, 'Funded multipay') as unknown as LCHFundedMultipay
    if (selectedDelivery !== undefined)
      selectedDelivery = snapshotLCHRecord(
        selectedDelivery,
        'Multipay Delivery'
      ) as unknown as LCHMultipayDelivery
    lchAssert(
      payment !== null &&
        typeof payment === 'object' &&
        payment.transactionState === 'finalized' &&
        payment.atomicBeef instanceof Uint8Array &&
        payment.atomicBeef.length > 0 &&
        payment.atomicBeef.length <= LCH_LIMITS.headerBytes &&
        Array.isArray(payment.deliveries),
      'ERR_LCH_PAYMENT',
      'Funded payment is invalid'
    )
    await this.validatePlanIntegrity(payment.plan)
    lchAssert(
      payment.deliveries.length === payment.plan.demands.length,
      'ERR_LCH_PAYMENT',
      'Funded payment does not contain one Delivery per Demand'
    )
    const transaction = Transaction.fromAtomicBEEF(payment.atomicBeef as AtomicBEEF)
    const seenDemands = new Set<string>()
    const seenOutputs = new Set<number>()
    for (const item of payment.deliveries) {
      const demand = await demandById(payment.plan.demands, item.demandId)
      const demandId = await objectId('payment-demand', demand.body)
      const demandIdHex = toHex(demandId)
      lchAssert(!seenDemands.has(demandIdHex), 'ERR_LCH_PAYMENT', 'Funded payment repeats a Demand')
      seenDemands.add(demandIdHex)
      equal(item.demandId, demandId, 'Funded Delivery Demand ID')
      equal(item.payee, memberBytes(demand.body, 'payee', 33), 'Funded Delivery Payee')
      lchAssert(
        item.endpoint === memberString(demand.body, 'endpoint'),
        'ERR_LCH_ENDPOINT',
        'Funded Delivery endpoint does not match its signed Demand'
      )
      await validatePaymentDelivery(item.delivery, undefined, this.validationOptions)
      equal(item.delivery.body.demandId, demandId, 'Payment Delivery Demand ID')
      equal(item.delivery.body.requestId, payment.plan.requestId, 'Payment Delivery Request ID')
      equal(item.delivery.body.buyer, this.signer.identityKey, 'Payment Delivery buyer')
      equal(
        memberBytesAny(item.delivery.body, 'atomicBeef'),
        payment.atomicBeef,
        'Payment Delivery Atomic BEEF'
      )
      const prefix = memberBytes(item.delivery.body, 'derivationPrefix', 32)
      equal(prefix, memberBytes(demand.body, 'derivationPrefix', 32), 'Derivation prefix')
      const suffix = memberBytes(item.delivery.body, 'derivationSuffix', 32)
      const outputIndex = Number(uint(item.delivery.body.outputIndex, 'Payment output index'))
      lchAssert(
        Number.isSafeInteger(outputIndex) &&
          !seenOutputs.has(outputIndex) &&
          transaction.outputs[outputIndex]?.satoshis !== undefined,
        'ERR_LCH_PAYMENT',
        'Payment Delivery output is absent or repeated'
      )
      seenOutputs.add(outputIndex)
      const output = transaction.outputs[outputIndex]
      lchAssert(
        BigInt(output.satoshis!) === uint(demand.body.satoshis, 'Demand amount'),
        'ERR_LCH_PAYMENT',
        'Payment Delivery output amount does not match its Demand'
      )
      const publicKey = requiredOwnDataValue(
        await this.wallet.getPublicKey({
          protocolID: [...BRC29_PAYMENT_PROTOCOL],
          keyID: `${toBase64Url(prefix)} ${toBase64Url(suffix)}`,
          counterparty: toHex(item.payee)
        }),
        'publicKey',
        'Wallet getPublicKey result'
      )
      lchAssert(typeof publicKey === 'string', 'ERR_LCH_PAYMENT', 'Wallet public key is invalid')
      const expectedScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
      equal(
        output.lockingScript.toUint8Array(),
        expectedScript.toUint8Array(),
        'Payment Delivery output locking script'
      )
    }
    if (selectedDelivery !== undefined) {
      const expected = payment.deliveries.find(
        item => toHex(item.demandId) === toHex(selectedDelivery.demandId)
      )
      lchAssert(
        expected !== undefined &&
          toHex(encodeDeterministicCbor(expected as unknown as LCHValue)) ===
            toHex(encodeDeterministicCbor(selectedDelivery as unknown as LCHValue)),
        'ERR_LCH_PAYMENT',
        'Selected Delivery is not part of the funded payment'
      )
    }
  }
}

async function demandById(
  demands: readonly SignedObject[],
  expected: Uint8Array
): Promise<SignedObject> {
  for (const demand of demands) {
    if (toHex(await objectId('payment-demand', demand.body)) === toHex(expected)) return demand
  }
  throw new Error('Payment Delivery refers to an unknown Demand')
}

function signedArray(value: LCHValue | undefined, minimum = 2): SignedObject[] {
  if (!Array.isArray(value) || value.length < minimum)
    throw new Error(
      minimum > 1
        ? 'Multilateral Quote requires at least two Payment Demands'
        : 'Quote requires at least one Payment Demand'
    )
  return value.map((item, index) => snapshotSignedObject(item, `Quote Payment Demand ${index}`))
}

function snapshotAuthorizedOutputEvidence(value: unknown, index: number): AuthorizedOutputEvidence {
  const name = `Authorized Output Evidence ${index}`
  return {
    authorization: snapshotSignedObject(
      requiredOwnDataValue(value, 'authorization', name),
      'Payment Authorization'
    ),
    delivery: snapshotSignedObject(
      requiredOwnDataValue(value, 'delivery', name),
      'Payment Delivery'
    ),
    transactionEvidence: snapshotSignedObject(
      requiredOwnDataValue(value, 'transactionEvidence', name),
      'Transaction Evidence'
    ),
    deliveryAcknowledgement: snapshotSignedObject(
      requiredOwnDataValue(value, 'deliveryAcknowledgement', name),
      'Payment Delivery Acknowledgement'
    )
  }
}

function memberBytes(body: Record<string, LCHValue>, key: string, length: number): Uint8Array {
  const value = body[key]
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error(`${key} is invalid`)
  return value
}

function memberBytesValue(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error(`${name} is invalid`)
  return value
}

function memberBytesAny(body: Record<string, LCHValue>, key: string): Uint8Array {
  const value = body[key]
  if (!(value instanceof Uint8Array) || value.length === 0) throw new Error(`${key} is invalid`)
  return value
}

function memberString(body: Record<string, LCHValue>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is invalid`)
  return value
}

function mapValue(value: LCHValue | undefined, name: string): Record<string, LCHValue> {
  lchAssert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_LICENSE',
    `${name} is invalid`
  )
  return value
}

function uint(value: LCHValue | undefined, name: string): bigint {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)))
    throw new Error(`${name} is invalid`)
  const result = BigInt(value)
  if (result < 0n) throw new Error(`${name} is negative`)
  return result
}

function equal(value: LCHValue | undefined, expected: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || toHex(value) !== toHex(expected))
    throw new Error(`${name} does not match`)
}

function normalizedSelectionValue(value: LCHValue | undefined, name: string): LCHValue {
  lchAssert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_LICENSE',
    `${name} is invalid`
  )
  const selection = value as unknown as Selection
  validateNormalizedSelection(selection)
  return normalizeSelection(selection) as unknown as Record<string, LCHValue>
}

function equalOptionalSelection(
  value: LCHValue | undefined,
  expected: LCHValue | undefined,
  name: string
): void {
  lchAssert(
    (value === undefined) === (expected === undefined),
    'ERR_LCH_LICENSE',
    `${name} does not match`
  )
  if (value !== undefined && expected !== undefined)
    equalLCHValue(
      normalizedSelectionValue(value, name),
      normalizedSelectionValue(expected, `Quote ${name}`),
      name
    )
}

function equalLCHValue(value: LCHValue, expected: LCHValue, name: string): void {
  lchAssert(
    toHex(encodeDeterministicCbor(value)) === toHex(encodeDeterministicCbor(expected)),
    'ERR_LCH_LICENSE',
    `${name} does not match`
  )
}

function validateFulfillments(
  value: LCHValue | undefined,
  expected: readonly Record<string, LCHValue>[]
): void {
  lchAssert(Array.isArray(value), 'ERR_LCH_LICENSE', 'License fulfillments are invalid')
  const actual = value.map(fulfillment => {
    lchAssert(
      fulfillment !== null &&
        typeof fulfillment === 'object' &&
        !Array.isArray(fulfillment) &&
        !(fulfillment instanceof Uint8Array),
      'ERR_LCH_LICENSE',
      'License fulfillment is invalid'
    )
    return toHex(encodeDeterministicCbor(fulfillment))
  })
  const required = expected.map(fulfillment => toHex(encodeDeterministicCbor(fulfillment)))
  actual.sort((left, right) => left.localeCompare(right))
  required.sort((left, right) => left.localeCompare(right))
  lchAssert(
    actual.length === required.length && actual.every((item, index) => item === required[index]),
    'ERR_LCH_LICENSE',
    'License fulfillments do not match the submitted settlement proofs'
  )
}

function validateLicenseKeyGrants(
  value: LCHValue | undefined,
  selectionValue: LCHValue | undefined,
  expectation: LCHLicenseKeyGrantExpectation
): void {
  lchAssert(Array.isArray(value), 'ERR_LCH_KEY', 'License key grants are invalid')
  const grants: KeyGrant[] = value.map(item => {
    lchAssert(
      item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        !(item instanceof Uint8Array),
      'ERR_LCH_KEY',
      'License key grant is invalid'
    )
    const keys = Object.keys(item).sort((left, right) => left.localeCompare(right))
    lchAssert(
      keys.join(',') === 'delivery,keyId,payload',
      'ERR_LCH_KEY',
      'License key grant fields are invalid'
    )
    const keyId = memberBytes(item, 'keyId', 32)
    const delivery = memberString(item, 'delivery')
    const payload = memberBytesAny(item, 'payload')
    return { keyId, delivery, payload }
  })
  lchAssert(
    new Set(grants.map(grant => toHex(grant.keyId))).size === grants.length,
    'ERR_LCH_KEY',
    'License contains duplicate Key IDs'
  )
  if (expectation.type === 'none') {
    lchAssert(grants.length === 0, 'ERR_LCH_KEY', 'License returned unexpected key grants')
    return
  }
  const selection = normalizedSelectionValue(
    selectionValue,
    'License key Selection'
  ) as unknown as Selection
  validateKeyGrantsForSelection(expectation.encryption, selection, grants)
  lchAssert(
    grants.every(grant => grant.delivery === expectation.delivery),
    'ERR_LCH_KEY',
    'License key delivery mechanism does not match the selected Offer mechanism'
  )
}

function validateKeyGrantExpectation(expectation: LCHLicenseKeyGrantExpectation): void {
  lchAssert(
    expectation !== null && typeof expectation === 'object',
    'ERR_LCH_KEY',
    'License key-grant expectation is invalid'
  )
  if (expectation.type === 'none') return
  lchAssert(
    expectation.type === 'segmented',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'License key-grant expectation is unsupported'
  )
  validateEncryptionDescriptor(expectation.encryption)
  lchAssert(
    typeof expectation.delivery === 'string' && expectation.delivery.length > 0,
    'ERR_LCH_KEY',
    'Expected License key-delivery mechanism is absent'
  )
}
