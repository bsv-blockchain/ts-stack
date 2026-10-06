import {
  ownOutputJSON,
  Beef,
  Transaction,
  Utils,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  parseOutputChain,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  verifyOutputPurchaseTerms,
  type CreateActionArgs,
  type SignActionResult,
  type OutputChain,
  type OutputJSONObject,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import {
  assembleLineage,
  lineageLimits,
  type ListingLineagePackage
} from '../revenue-listing/LineagePackage.js'
import {
  REVENUE_LISTING_PURCHASE_PROFILE,
  REVENUE_LISTING_LINEAGE_SCHEMA
} from '../revenue-listing/RevenueListingPurchaseVerifier.js'
import type { ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import type {
  PrivatePurchaseBuyerPayment,
  PrivatePurchaseBuyerPaymentOutcome
} from './PrivatePurchaseBuyerPorts.js'
import type { RecoverableBuyerActions } from './WalletToolboxBuyerPayment.js'
interface Plan {
  format: 'private-purchase-wallet/1' | 'private-purchase-wallet/2'
  operationId: string
  binding: OutputJSONObject
  prepare: OutputPurchasePrepare
  terms: OutputSignedPurchaseTerms
  request: CreateActionArgs
}
export interface WalletToolboxPurchasePaymentCoreOptions {
  actions: RecoverableBuyerActions
  family: { lock: unknown; decode: unknown }
  chains: ChainViewResolver
  /** Independently installed chain/policy identity, included in durable installation binding. */
  verificationId: string
  context(): VerificationContext
  checkCurrent(context: VerificationContext): void
  binding: {
    wallet: string
    storage: string
    chain: OutputChain
    originator: string
    seller: string
  }
  /** Full canonical submission capacity; refuses too-large funded material before signing. */
  maximumCandidateBytes: number
}
export interface PurchaseWalletDescriptor {
  chain: OutputChain
  seller: string
  assetId: string
  termsDigest: string
}
export interface PurchaseWalletSpend {
  plan(): {
    inputs: { txid: string; outputIndex: number }[]
    outputs: { satoshis: string; lockingScript: string }[]
  }
  estimateUnlockingLength(index: number): number
  prepare(transaction: Transaction): {
    signingRequests(): readonly unknown[]
    complete(): Transaction
    assertFinalLayout(transaction: Transaction): void
  }
}
/** Internal, explicitly selected family behavior; never a wallet-supplied mode. */
export interface PurchaseWalletDomain<D extends PurchaseWalletDescriptor> {
  readonly format: 'private-purchase-wallet/1' | 'private-purchase-wallet/2'
  readonly script: string | OutputJSONObject
  parse(input: Uint8Array): ListingLineagePackage<D>
  spend(
    lineage: ListingLineagePackage<D>,
    predecessor: Transaction,
    terms: OutputSignedPurchaseTerms
  ): PurchaseWalletSpend
  verifier(): {
    verify(
      lineage: ListingLineagePackage<D>,
      context: VerificationContext,
      signal: AbortSignal
    ): Promise<{ status: string }>
  }
  eligible(lineage: ListingLineagePackage<D>, context: VerificationContext): void
}
/** Complete shared noSend intent, funding, layout, final effect and recovery pipeline. */
export class WalletToolboxPurchasePaymentCore<
  D extends PurchaseWalletDescriptor
> implements PrivatePurchaseBuyerPayment {
  readonly maximumCandidateBytes: number
  private readonly installed: OutputJSONObject
  private readonly descriptor: string
  private readonly pins: (() => boolean)[]
  private readonly lineage: ReturnType<PurchaseWalletDomain<D>['verifier']>
  get configuration(): OutputJSONObject {
    return structuredClone(this.installed)
  }
  constructor(
    private readonly ports: WalletToolboxPurchasePaymentCoreOptions,
    private readonly domain: PurchaseWalletDomain<D>
  ) {
    const b = ownOutputJSON(ports.binding, { bytes: 4096 }).value
    closedOutputObject(b, ['wallet', 'storage', 'chain', 'originator', 'seller'])
    outputAssert(
      Number.isSafeInteger(ports.maximumCandidateBytes) &&
        ports.maximumCandidateBytes > 0 &&
        ports.maximumCandidateBytes <= 4194304,
      'Invalid complete purchase submission bound'
    )
    outputAssert(
      typeof ports.checkCurrent === 'function' &&
        ports.checkCurrent.constructor.name !== 'AsyncFunction',
      'Purchase chain guard must be synchronous'
    )
    this.maximumCandidateBytes = ports.maximumCandidateBytes
    this.installed = {
      protocol: 'wallet-action-recovery-v1',
      wallet: outputIdentity(b.wallet),
      storage: outputString(b.storage),
      chain: parseOutputChain(b.chain),
      originator: outputString(b.originator),
      seller: outputIdentity(b.seller),
      verification: outputString(ports.verificationId),
      script: structuredClone(domain.script),
      maximumCandidateBytes: this.maximumCandidateBytes
    }
    const descriptor = ports.actions.configuration()
    outputAssert(
      descriptor.protocol === this.installed.protocol &&
        descriptor.walletIdentity === this.installed.wallet &&
        descriptor.storageIdentity === this.installed.storage &&
        descriptor.chain === parseOutputChain(this.installed.chain).network &&
        descriptor.originator === this.installed.originator,
      'Purchase wallet owner differs from original binding',
      'context-changed'
    )
    this.descriptor = canonicalOutputJSON(descriptor)
    const { actions, family, chains } = ports
    this.pins = [
      () => ports.actions === actions,
      () => ports.family === family,
      () => ports.chains === chains,
      pin(ports.actions, 'configuration'),
      pin(ports.actions, 'prepare'),
      pin(ports.actions, 'recover'),
      pin(ports.actions, 'finalize'),
      pin(ports.family, 'lock'),
      pin(ports.family, 'decode'),
      pin(ports.chains, 'resolve'),
      pin(ports, 'context'),
      pin(ports, 'checkCurrent')
    ]
    this.lineage = domain.verifier()
  }
  private current(signal: AbortSignal): void {
    outputAssert(!signal.aborted, 'Purchase wallet work cancelled', 'cancelled')
    outputAssert(
      this.pins.every(check => check()) &&
        canonicalOutputJSON(this.ports.actions.configuration()) === this.descriptor &&
        this.ports.verificationId === this.installed.verification &&
        this.ports.maximumCandidateBytes === this.installed.maximumCandidateBytes &&
        this.maximumCandidateBytes === this.installed.maximumCandidateBytes,
      'Purchase wallet installation changed',
      'context-changed'
    )
  }
  private guard(context: VerificationContext, signal: AbortSignal): void {
    this.current(signal)
    const result: unknown = this.ports.checkCurrent(context)
    if (result instanceof Promise) void result.catch(() => undefined)
    outputAssert(result === undefined, 'Purchase chain guard did not complete', 'context-changed')
  }
  private original(requestInput: unknown, termsInput: unknown) {
    const prepare = parseOutputPurchasePrepare(requestInput),
      terms = verifyOutputPurchaseTerms(termsInput, prepare, this.installed.seller as string)
    outputAssert(
      prepare.recipient === this.installed.wallet &&
        canonicalOutputJSON(prepare.listing.chain) === canonicalOutputJSON(this.installed.chain) &&
        terms.body.domainProfile === REVENUE_LISTING_PURCHASE_PROFILE &&
        terms.body.domainEvidence.schema === REVENUE_LISTING_LINEAGE_SCHEMA,
      'Purchase wallet original domain, recipient or chain differs',
      'context-changed'
    )
    const bytes = Uint8Array.from(decodeOutputBytes(terms.body.domainEvidence.bytes, 4194304)),
      lineage = this.domain.parse(bytes),
      exact = new TextEncoder().encode(canonicalOutputJSON(lineage, { bytes: 4194304 }))
    outputAssert(
      Utils.toHex(bytes) === Utils.toHex(exact) &&
        canonicalOutputJSON(lineage.target) === canonicalOutputJSON(prepare.listing) &&
        lineage.descriptor.seller === this.installed.seller &&
        lineage.descriptor.assetId === prepare.assetId &&
        lineage.descriptor.termsDigest === prepare.termsDigest,
      'Purchase wallet preparation changed complete listing evidence',
      'context-changed'
    )
    const assembly = assembleLineage(lineage, lineageLimits({})),
      predecessor = assembly.beef.findAtomicTransaction(lineage.target.txid)
    outputAssert(
      predecessor !== undefined,
      'Purchase predecessor evidence unavailable',
      'unavailable'
    )
    const spend = this.domain.spend(lineage, predecessor, terms),
      plan = spend.plan(),
      request: CreateActionArgs = {
        description: 'Original private covenant purchase',
        inputBEEF: assembly.beef.toUint8ArrayAtomic(lineage.target.txid),
        inputs: plan.inputs.map((input, index) => ({
          outpoint: `${input.txid}.${input.outputIndex}`,
          inputDescription: 'Original listing predecessor',
          unlockingScriptLength: spend.estimateUnlockingLength(index)
        })),
        outputs: plan.outputs.map(output => ({
          ...output,
          satoshis: Number(output.satoshis),
          outputDescription: 'Required covenant purchase output'
        })),
        options: {
          noSend: true,
          signAndProcess: false,
          randomizeOutputs: false,
          returnTXIDOnly: false
        }
      }
    return { prepare, terms, lineage, spend, request }
  }
  private requestObject(request: CreateActionArgs): OutputJSONObject {
    return {
      ...request,
      inputBEEF: Utils.toBase64(request.inputBEEF!)
    } as unknown as OutputJSONObject
  }
  private stored(plan: Plan): OutputJSONObject {
    return ownOutputJSON({ ...plan, request: this.requestObject(plan.request) }, { bytes: 4194304 })
      .value as OutputJSONObject
  }
  private parse(input: OutputJSONObject): Plan {
    const value = ownOutputJSON(input, { bytes: 4194304 }).value
    closedOutputObject(value, ['format', 'operationId', 'binding', 'prepare', 'terms', 'request'])
    outputAssert(
      value.format === this.domain.format &&
        canonicalOutputJSON(value.binding) === canonicalOutputJSON(this.installed),
      'Purchase wallet plan owner differs',
      'context-changed'
    )
    const original = this.original(value.prepare, value.terms)
    outputAssert(
      canonicalOutputJSON(value.request, { bytes: 4194304 }) ===
        canonicalOutputJSON(this.requestObject(original.request), { bytes: 4194304 }),
      'Purchase wallet construction changed',
      'context-changed'
    )
    return {
      format: this.domain.format,
      operationId: outputHex32(value.operationId),
      binding: this.configuration,
      prepare: original.prepare,
      terms: original.terms,
      request: original.request
    }
  }
  private async verified(
    plan: Plan,
    signal: AbortSignal
  ): Promise<{ context: VerificationContext; checkEligible(): void }> {
    const original = this.original(plan.prepare, plan.terms),
      context = structuredClone(this.ports.context())
    outputAssert(
      canonicalOutputJSON(context.view.chain) === canonicalOutputJSON(this.installed.chain),
      'Purchase wallet verification chain changed',
      'context-changed'
    )
    this.guard(context, signal)
    const result = await this.lineage.verify(original.lineage, context, signal)
    this.guard(context, signal)
    outputAssert(
      result.status === 'verified',
      'Purchase wallet complete lineage is unresolved or invalid',
      'unavailable'
    )
    const checkEligible = () => this.domain.eligible(original.lineage, context)
    checkEligible()
    return { context, checkEligible }
  }
  async plan(
    operationId: string,
    prepare: OutputPurchasePrepare,
    terms: OutputSignedPurchaseTerms,
    signal: AbortSignal
  ): Promise<OutputJSONObject> {
    this.current(signal)
    const original = this.original(prepare, terms),
      plan: Plan = {
        format: this.domain.format,
        operationId: outputHex32(operationId),
        binding: this.configuration,
        prepare: original.prepare,
        terms: original.terms,
        request: original.request
      }
    await this.verified(plan, signal)
    this.current(signal)
    return this.stored(plan)
  }
  private funded(plan: Plan, bytes: number[] | Uint8Array) {
    const beef = Beef.fromBinaryStrict(Array.from(bytes)),
      tx = Transaction.fromAtomicBEEF(Array.from(bytes)),
      original = this.original(plan.prepare, plan.terms)
    tx.inputs.forEach(input => {
      input.sourceTransaction = beef.findTransactionForSigning(input.sourceTXID!)
    })
    const prepared = original.spend.prepare(tx)
    outputAssert(
      prepared.signingRequests().length === 0,
      'Permissionless purchase cannot request seller signatures'
    )
    return {
      beef,
      tx,
      prepared,
      complete: prepared.complete()
    }
  }
  private candidate(plan: Plan, result: SignActionResult): OutputPurchaseSubmit {
    outputAssert(
      result.tx !== undefined && result.txid !== undefined,
      'Original signed purchase evidence unavailable',
      'unavailable'
    )
    const funded = this.funded(plan, result.tx)
    funded.prepared.assertFinalLayout(funded.tx)
    outputAssert(
      funded.tx.id('hex') === result.txid &&
        funded.tx.inputs[0].unlockingScript?.toHex() ===
          funded.complete.inputs[0].unlockingScript?.toHex(),
      'Original wallet result changed purchase layout or unlocking',
      'context-changed'
    )
    const candidate = parseOutputPurchaseSubmit({
      version: 1,
      acquisitionId: plan.terms.body.acquisitionId,
      txid: result.txid,
      beef: Utils.toBase64(result.tx)
    })
    canonicalOutputJSON(candidate, { bytes: this.maximumCandidateBytes })
    return candidate
  }
  async recover(
    input: OutputJSONObject,
    signal: AbortSignal
  ): Promise<PrivatePurchaseBuyerPaymentOutcome> {
    this.current(signal)
    const plan = this.parse(input),
      recovered = await this.ports.actions.recover(plan.operationId, plan.request)
    this.current(signal)
    return recovered.state === 'finalized'
      ? { state: 'finalized', candidate: this.candidate(plan, recovered.result) }
      : { state: recovered.state }
  }
  async finish(
    input: OutputJSONObject,
    checkNewWork: () => void,
    signal: AbortSignal
  ): Promise<OutputPurchaseSubmit> {
    this.current(signal)
    outputAssert(
      checkNewWork.constructor.name !== 'AsyncFunction',
      'Purchase new-work guard must be synchronous'
    )
    const plan = this.parse(input)
    let recovered = await this.ports.actions.recover(plan.operationId, plan.request)
    this.current(signal)
    if (recovered.state === 'finalized') return this.candidate(plan, recovered.result)
    const { context, checkEligible } = await this.verified(plan, signal),
      guard = () => {
        this.guard(context, signal)
        checkEligible()
        const result: unknown = checkNewWork()
        if (result instanceof Promise) void result.catch(() => undefined)
        outputAssert(
          result === undefined,
          'Purchase new-work guard did not complete',
          'context-changed'
        )
      }
    guard()
    if (recovered.state === 'absent') {
      await this.ports.actions.prepare(plan.operationId, plan.request)
      guard()
      recovered = await this.ports.actions.recover(plan.operationId, plan.request)
      guard()
    }
    if (recovered.state === 'finalized') return this.candidate(plan, recovered.result)
    outputAssert(
      recovered.state === 'prepared' && recovered.result.signableTransaction !== undefined,
      'Original funded purchase is unresolved',
      'unavailable'
    )
    const signing = recovered.result.signableTransaction,
      funded = this.funded(plan, signing.tx)
    // Bound complete evidence and worst-case remaining native input signatures
    // before new signing. The original prepared intent remains recoverable if refused.
    funded.beef.mergeTransaction(funded.complete)
    for (const input of funded.tx.inputs.slice(plan.request.inputs!.length)) {
      const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      outputAssert(
        source !== undefined && /^76a914[0-9a-f]{40}88ac$/.test(source.lockingScript.toHex()),
        'Purchase native funding requires bounded P2PKH inputs',
        'unsupported'
      )
    }
    const completeBytes = funded.beef.toBinaryAtomic(funded.complete.id('hex')).length,
      remainingInputs = funded.complete.inputs.length - plan.request.inputs!.length,
      maximumBytes = completeBytes + remainingInputs * 110
    outputAssert(
      Math.ceil(maximumBytes / 3) * 4 + 512 <= this.maximumCandidateBytes,
      'Funded purchase exceeds original complete submission capacity',
      'limited'
    )
    guard()
    const result = await this.ports.actions.finalize(
      plan.operationId,
      plan.request,
      {
        reference: signing.reference,
        spends: Object.fromEntries(
          plan.request.inputs!.map((_, index) => [
            index,
            { unlockingScript: funded.complete.inputs[index].unlockingScript!.toHex() }
          ])
        )
      },
      guard
    )
    this.current(signal)
    return this.candidate(plan, result)
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Purchase wallet capability required')
  return () => owner[key] === method
}
