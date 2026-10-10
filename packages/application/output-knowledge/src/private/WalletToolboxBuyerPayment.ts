import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  inspectOutputPaidLookupFunding,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  parseOutputChain,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupPayment,
  P2PKH,
  PublicKey,
  Utils,
  type CreateActionArgs,
  type CreateActionResult,
  type SignActionArgs,
  type SignActionResult,
  type OutputChain,
  type OutputJSONObject,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type WalletInterface
} from '@bsv/sdk'
import type {
  PrivateLookupBuyerPayment,
  PrivateLookupBuyerPaymentOutcome
} from './PrivateLookupBuyerPorts.js'

export interface RecoverableBuyerActions {
  configuration(): {
    protocol: 'wallet-action-recovery-v1'
    walletIdentity: string
    storageIdentity: string
    chain: string
    originator: string
  }
  prepare(operationId: string, request: CreateActionArgs): Promise<CreateActionResult>
  recover(
    operationId: string,
    request: CreateActionArgs
  ): Promise<
    | { state: 'absent' }
    | { state: 'prepared'; result: CreateActionResult }
    | { state: 'finalized'; result: SignActionResult }
  >
  finalize(
    operationId: string,
    request: CreateActionArgs,
    signing: SignActionArgs,
    checkNewSigning?: () => void
  ): Promise<SignActionResult>
}
interface Plan {
  format: 'private-lookup-buyer-payment/1'
  operationId: string
  binding: OutputJSONObject
  challenge: OutputPaidLookupChallenge
  derivationSuffix: string
  sellerPaymentKey: string
  request: CreateActionArgs
}
/** Explicit local noSend adapter: no ordinary wallet fallback, random retry or broadcast. */
export class WalletToolboxBuyerPayment implements PrivateLookupBuyerPayment {
  private readonly installed: OutputJSONObject
  private readonly descriptor: string
  private readonly identities: (() => boolean)[]
  get configuration(): OutputJSONObject {
    return structuredClone(this.installed)
  }
  constructor(
    private readonly actions: RecoverableBuyerActions,
    private readonly wallet: Pick<WalletInterface, 'getPublicKey'>,
    binding: { wallet: string; storage: string; chain: OutputChain; originator: string }
  ) {
    const owned = ownOutputJSON(binding, { bytes: 4096 }).value
    closedOutputObject(owned, ['wallet', 'storage', 'chain', 'originator'])
    this.installed = {
      protocol: 'wallet-action-recovery-v1',
      wallet: outputIdentity(owned.wallet),
      storage: outputString(owned.storage),
      chain: parseOutputChain(owned.chain),
      originator: outputString(owned.originator)
    }
    const descriptor = actions.configuration()
    outputAssert(
      descriptor.protocol === this.installed.protocol &&
        descriptor.walletIdentity === this.installed.wallet &&
        descriptor.storageIdentity === this.installed.storage &&
        descriptor.chain === parseOutputChain(this.installed.chain).network &&
        descriptor.originator === this.installed.originator,
      'Buyer wallet owner differs from original binding',
      'context-changed'
    )
    this.descriptor = canonicalOutputJSON(descriptor)
    this.identities = [
      pin(actions, 'configuration'),
      pin(actions, 'prepare'),
      pin(actions, 'recover'),
      pin(actions, 'finalize'),
      pin(wallet, 'getPublicKey')
    ]
  }
  private current(signal: AbortSignal): void {
    outputAssert(!signal.aborted, 'Buyer wallet work cancelled', 'cancelled')
    outputAssert(
      this.identities.every(check => check()) &&
        canonicalOutputJSON(this.actions.configuration()) === this.descriptor,
      'Buyer wallet owner changed',
      'context-changed'
    )
  }
  async plan(
    operationId: string,
    input: OutputPaidLookupChallenge,
    suffix: string,
    signal: AbortSignal
  ): Promise<OutputJSONObject> {
    this.current(signal)
    const challenge = parseOutputPaidLookupChallenge(input)
    outputAssert(
      challenge.buyer === this.installed.wallet,
      'Buyer quote names another wallet',
      'context-changed'
    )
    parseOutputPaidLookupPayment({
      derivationPrefix: challenge.derivationPrefix,
      derivationSuffix: suffix,
      transaction: ''
    })
    const identity = await this.wallet.getPublicKey(
      { identityKey: true },
      this.installed.originator as string
    )
    this.current(signal)
    outputAssert(
      identity.publicKey === this.installed.wallet,
      'Buyer derivation wallet differs',
      'context-changed'
    )
    const key = await this.wallet.getPublicKey(
      {
        protocolID: [2, '3241645161d8'],
        keyID: `${challenge.derivationPrefix} ${suffix}`,
        counterparty: challenge.seller
      },
      this.installed.originator as string
    )
    this.current(signal)
    const plan: Plan = {
      format: 'private-lookup-buyer-payment/1',
      operationId: outputHex32(operationId),
      binding: this.configuration,
      challenge,
      derivationSuffix: suffix,
      sellerPaymentKey: outputIdentity(key.publicKey),
      request: this.request(challenge, suffix, key.publicKey)
    }
    return ownOutputJSON(plan, { bytes: 65536 }).value as OutputJSONObject
  }
  private request(
    challenge: OutputPaidLookupChallenge,
    suffix: string,
    key: string
  ): CreateActionArgs {
    return {
      description: 'Original private lookup payment',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PublicKey.fromString(key).toAddress()).toHex(),
          satoshis: Number(challenge.satoshis),
          outputDescription: 'Original selected seller payment',
          customInstructions: canonicalOutputJSON({
            derivationPrefix: challenge.derivationPrefix,
            derivationSuffix: suffix,
            payee: challenge.seller
          })
        }
      ],
      options: {
        noSend: true,
        signAndProcess: false,
        randomizeOutputs: false,
        returnTXIDOnly: false
      }
    }
  }
  private parse(input: OutputJSONObject): Plan {
    const value = ownOutputJSON(input, { bytes: 65536 }).value
    closedOutputObject(value, [
      'format',
      'operationId',
      'binding',
      'challenge',
      'derivationSuffix',
      'sellerPaymentKey',
      'request'
    ])
    outputAssert(
      value.format === 'private-lookup-buyer-payment/1' &&
        canonicalOutputJSON(value.binding) === canonicalOutputJSON(this.installed),
      'Buyer payment plan owner differs',
      'context-changed'
    )
    const challenge = parseOutputPaidLookupChallenge(value.challenge),
      suffix = outputString(value.derivationSuffix),
      key = outputIdentity(value.sellerPaymentKey)
    parseOutputPaidLookupPayment({
      derivationPrefix: challenge.derivationPrefix,
      derivationSuffix: suffix,
      transaction: ''
    })
    outputAssert(
      challenge.buyer === this.installed.wallet &&
        canonicalOutputJSON(value.request) ===
          canonicalOutputJSON(this.request(challenge, suffix, key)),
      'Buyer payment construction changed',
      'context-changed'
    )
    return {
      format: 'private-lookup-buyer-payment/1',
      operationId: outputHex32(value.operationId),
      binding: this.configuration,
      challenge,
      derivationSuffix: suffix,
      sellerPaymentKey: key,
      request: this.request(challenge, suffix, key)
    }
  }
  private payment(plan: Plan, result: SignActionResult): OutputPaidLookupPayment {
    outputAssert(
      result.tx !== undefined,
      'Original signed payment evidence is unavailable',
      'unavailable'
    )
    const payment = parseOutputPaidLookupPayment({
      derivationPrefix: plan.challenge.derivationPrefix,
      derivationSuffix: plan.derivationSuffix,
      transaction: Utils.toBase64(result.tx)
    })
    decodeOutputBytes(payment.transaction, 65536)
    const checked = inspectOutputPaidLookupFunding(payment, plan.challenge, {
      chain: parseOutputChain(this.installed.chain),
      sellerPaymentKey: plan.sellerPaymentKey
    })
    outputAssert(
      result.txid === checked.operation.funding.txid,
      'Retained payment transaction identity differs',
      'unavailable'
    )
    return payment
  }
  async recover(
    input: OutputJSONObject,
    signal: AbortSignal
  ): Promise<PrivateLookupBuyerPaymentOutcome> {
    this.current(signal)
    const plan = this.parse(input),
      recovered = await this.actions.recover(plan.operationId, plan.request)
    this.current(signal)
    return recovered.state === 'finalized'
      ? { state: 'finalized', payment: this.payment(plan, recovered.result) }
      : { state: recovered.state }
  }
  async finish(
    input: OutputJSONObject,
    checkNewWork: () => void,
    signal: AbortSignal
  ): Promise<OutputPaidLookupPayment> {
    const plan = this.parse(input)
    this.current(signal)
    let recovered = await this.actions.recover(plan.operationId, plan.request)
    this.current(signal)
    if (recovered.state === 'finalized') return this.payment(plan, recovered.result)
    const guard = () => {
      this.current(signal)
      const allowed: unknown = checkNewWork()
      if (allowed instanceof Promise) void allowed.catch(() => undefined)
      outputAssert(allowed === undefined, 'Buyer new-work guard must return void synchronously')
    }
    outputAssert(
      typeof checkNewWork === 'function' && checkNewWork.constructor.name !== 'AsyncFunction',
      'Buyer new-work guard must be synchronous'
    )
    guard()
    if (recovered.state === 'absent') {
      const result = await this.actions.prepare(plan.operationId, plan.request)
      this.current(signal)
      recovered = { state: 'prepared', result }
    }
    guard()
    outputAssert(
      recovered.result.signableTransaction !== undefined,
      'Original preparation is incomplete',
      'unavailable'
    )
    const signed = await this.actions.finalize(
      plan.operationId,
      plan.request,
      {
        reference: recovered.result.signableTransaction.reference,
        spends: {},
        options: { noSend: true, returnTXIDOnly: false }
      },
      guard
    )
    this.current(signal)
    return this.payment(plan, signed)
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Buyer native recovery capability is required')
  return () => owner[key] === method
}
