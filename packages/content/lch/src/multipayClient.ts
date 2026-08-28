import { Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import {
  LCHBuyer,
  validateLicenseRequest,
  validatePaymentDemand,
  validatePaymentReceipt,
  validatePaymentReadiness,
  validateQuote,
  type LicenseRequestOptions,
  type PaymentCompletion
} from './acquisition.js'
import { LCHHttpAcquisitionClient, type LCHHttpClientOptions } from './http.js'
import { fromHex, objectId, toHex } from './hash.js'
import { LCH_SETTLEMENT_PROFILES } from './constants.js'
import { createMultipayTransaction } from './walletPayment.js'
import { PublicBRC77Verifier, WalletBRC77Signer } from './signatures.js'
import { verifySignedObject } from './objects.js'
import {
  validateAuthorizedOutputEvidence,
  validateDeliveryAcknowledgement,
  validatePaymentAuthorization,
  validateTransactionEvidence,
  type AuthorizedOutputEvidence
} from './settlement.js'
import type { LCHSigner, LCHTransactionState, LCHValue, SignedObject } from './types.js'

export interface LCHMultipayPlan {
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

export interface LCHMultipayBuyerOptions extends LCHHttpClientOptions {
  now?: () => bigint
  transport?: LCHAcquisitionTransport
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
  recover(endpoint: string, requestId: Uint8Array): Promise<SignedObject | undefined>
}

/** A complete non-custodial BRC-170 multipay buyer workflow. */
export class LCHMultipayBuyer {
  private readonly buyer: LCHBuyer
  private readonly transport: LCHAcquisitionTransport
  private readonly now: () => bigint
  private readonly allowInsecureLocalOrigins: readonly string[]

  constructor(
    private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'createAction'>,
    private readonly signer: LCHSigner,
    options: LCHMultipayBuyerOptions = {}
  ) {
    this.buyer = new LCHBuyer(signer)
    this.transport = options.transport ?? new LCHHttpAcquisitionClient(options)
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.allowInsecureLocalOrigins = options.endpointPolicy?.allowLocalOrigins ?? []
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
    endpoint: string,
    request: SignedObject,
    issuer: Uint8Array
  ): Promise<LCHMultipayPlan> {
    const requestId = await validateLicenseRequest(request)
    await this.transport.preflightLicense(endpoint, request)
    const quote = await this.transport.quote(endpoint, request)
    await validateQuote(quote, request, issuer, undefined, {
      allowInsecureLocalOrigins: this.allowInsecureLocalOrigins
    })
    const demands = signedArray(quote.body.demands)
    const readiness = await this.obtainReadiness(demands)
    const authorizations = await this.obtainAuthorizations(demands)
    let totalSatoshis = 0n
    for (const demand of demands) {
      await validatePaymentDemand(demand, undefined, {
        allowInsecureLocalOrigins: this.allowInsecureLocalOrigins
      })
      equal(demand.body.requestId, requestId, 'Demand Request ID')
      totalSatoshis += uint(demand.body.satoshis, 'Demand amount')
    }
    if (totalSatoshis !== uint(quote.body.totalSatoshis, 'Quote total'))
      throw new Error('Quote total does not equal its Payment Demands')
    return {
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
      recoveryUntil: uint(quote.body.recoveryUntil, 'Quote recovery deadline')
    }
  }

  async createPayment(plan: LCHMultipayPlan): Promise<LCHFundedMultipay> {
    const now = this.now()
    if (now >= plan.expiresAt)
      throw new Error('The signed Quote expired before transaction creation')
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
    if (this.now() >= plan.expiresAt)
      throw new Error('The signed Quote expired before readiness refresh')
    return { ...plan, readiness: await this.obtainReadiness(plan.demands) }
  }

  async deliver(payment: LCHFundedMultipay, item: LCHMultipayDelivery): Promise<SignedObject> {
    const receipt = await this.transport.deliver(item.endpoint, item.delivery)
    await validatePaymentReceipt(receipt)
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
    return receipt
  }

  async complete(
    payment: LCHFundedMultipay,
    receipts: readonly SignedObject[],
    authorizedOutputs: readonly AuthorizedOutputEvidence[] = []
  ): Promise<SignedObject> {
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
    for (const receipt of receipts) {
      await validatePaymentReceipt(receipt)
      equal(receipt.body.requestId, payment.plan.requestId, 'Receipt Request ID')
      const demandId = memberBytes(receipt.body, 'demandId', 32)
      const demandIdHex = toHex(demandId)
      const delivery = expected.get(demandIdHex)
      if (delivery === undefined || seen.has(demandIdHex))
        throw new Error('Payment Completion has an unexpected or repeated Receipt')
      equal(receipt.body.payee, delivery.payee, 'Receipt Payee')
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
        { allowInsecureLocalOrigins: this.allowInsecureLocalOrigins }
      )
      seen.add(demandIdHex)
    }
    const completion: PaymentCompletion = {
      request: payment.plan.request,
      quote: payment.plan.quote,
      atomicBeef: payment.atomicBeef,
      receipts: [...receipts],
      authorizedOutputs: [...authorizedOutputs]
    }
    const license = await this.transport.complete(payment.plan.endpoint, completion)
    await verifySignedObject('license', license, new PublicBRC77Verifier(), payment.plan.issuer)
    equal(license.body.requestId, payment.plan.requestId, 'License Request ID')
    equal(license.body.subject, this.signer.identityKey, 'License subject')
    return license
  }

  recover(endpoint: string, requestId: Uint8Array): Promise<SignedObject | undefined> {
    return this.transport.recover(endpoint, requestId)
  }

  async collectAuthorizedOutputEvidence(
    payment: LCHFundedMultipay,
    item: LCHMultipayDelivery
  ): Promise<AuthorizedOutputEvidence> {
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
      { allowInsecureLocalOrigins: this.allowInsecureLocalOrigins }
    )
    const deliveryAcknowledgement = await this.transport.storeDelivery(
      memberString(authorization.body, 'deliveryEndpoint'),
      authorization,
      item.delivery
    )
    await validateDeliveryAcknowledgement(
      deliveryAcknowledgement,
      authorization,
      item.delivery,
      await objectId('payment-authorization', authorization.body),
      await objectId('payment-delivery', item.delivery.body),
      new PublicBRC77Verifier(),
      { allowInsecureLocalOrigins: this.allowInsecureLocalOrigins }
    )
    const transactionEvidence = await this.transport.attestTransaction(
      memberString(authorization.body, 'evidenceEndpoint'),
      authorization,
      payment.atomicBeef
    )
    await validateTransactionEvidence(
      transactionEvidence,
      authorization,
      await objectId('payment-authorization', authorization.body),
      Transaction.fromAtomicBEEF(payment.atomicBeef as AtomicBEEF),
      new PublicBRC77Verifier()
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
      { allowInsecureLocalOrigins: this.allowInsecureLocalOrigins }
    )
    return bundle
  }

  async settleDelivery(
    payment: LCHFundedMultipay,
    item: LCHMultipayDelivery
  ): Promise<LCHMultipaySettlement> {
    try {
      return { type: 'receipt', receipt: await this.deliver(payment, item) }
    } catch (error) {
      const demand = await demandById(payment.plan.demands, item.demandId)
      if (demand.body.settlementProfile !== LCH_SETTLEMENT_PROFILES.authorizedOutput) throw error
      return {
        type: 'authorized-output',
        evidence: await this.collectAuthorizedOutputEvidence(payment, item)
      }
    }
  }

  private async obtainReadiness(demands: readonly SignedObject[]): Promise<SignedObject[]> {
    const readiness: SignedObject[] = []
    for (const demand of demands) {
      const ready = await this.transport.preflightDemand(
        memberString(demand.body, 'endpoint'),
        demand
      )
      await validatePaymentReadiness(ready, demand, this.now(), new PublicBRC77Verifier(), {
        allowInsecureLocalOrigins: this.allowInsecureLocalOrigins
      })
      readiness.push(ready)
    }
    return readiness
  }

  private async obtainAuthorizations(demands: readonly SignedObject[]): Promise<SignedObject[]> {
    const authorizations: SignedObject[] = []
    for (const demand of demands) {
      if (demand.body.settlementProfile !== LCH_SETTLEMENT_PROFILES.authorizedOutput) continue
      const authorization = await this.transport.authorizePayment(
        memberString(demand.body, 'endpoint'),
        demand
      )
      await validatePaymentAuthorization(
        authorization,
        demand,
        this.now(),
        new PublicBRC77Verifier(),
        { allowInsecureLocalOrigins: this.allowInsecureLocalOrigins }
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
        await validatePaymentAuthorization(authorization, demand, now, new PublicBRC77Verifier(), {
          allowInsecureLocalOrigins: this.allowInsecureLocalOrigins
        })
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
      await validatePaymentReadiness(ready, demand, now, new PublicBRC77Verifier(), {
        allowInsecureLocalOrigins: this.allowInsecureLocalOrigins
      })
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

function signedArray(value: LCHValue | undefined): SignedObject[] {
  if (!Array.isArray(value) || value.length < 2)
    throw new Error('Multilateral Quote requires at least two Payment Demands')
  return value.map(item => {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item instanceof Uint8Array ||
      item.body === null ||
      typeof item.body !== 'object' ||
      Array.isArray(item.body) ||
      item.body instanceof Uint8Array ||
      !Array.isArray(item.signatures) ||
      !item.signatures.every(signature => signature instanceof Uint8Array)
    )
      throw new Error('Quote Payment Demand is invalid')
    return {
      body: item.body as Record<string, LCHValue>,
      signatures: item.signatures as Uint8Array[]
    }
  })
}

function memberBytes(body: Record<string, LCHValue>, key: string, length: number): Uint8Array {
  const value = body[key]
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error(`${key} is invalid`)
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
