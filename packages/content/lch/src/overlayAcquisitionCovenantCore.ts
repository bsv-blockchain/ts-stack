import {
  canonicalOutputJSON,
  Beef,
  parseOutputPurchaseSubmit,
  parseOutputPurchasePrepare,
  parseOutputPurchaseTerms,
  parseOutputEvidence,
  decodeOutputBytes,
  Hash,
  Utils,
  outputU64,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit,
  type OutputReleaseBinding,
  type OutputReleaseEvidence,
  type WalletInterface
} from '@bsv/sdk'
import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCHReader } from './core.js'
import {
  retainLCHCovenantPurchaseAssessment,
  type LCHOverlayVerifiedCovenantPurchase
} from './overlayAcquisitionCovenantProof.js'
import { lchOverlayCovenantEntitlementDigest } from './overlayAcquisitionCovenantEntitlement.js'
import { LCHOverlayPaidCustody, type LCHOverlayObjectCustody } from './overlayAcquisitionCustody.js'
import { lchAssert } from './errors.js'
import { WalletBRC78KeyRecovery } from './keyRecovery.js'
import { lchOverlaySignatureBudget } from './overlayAcquisitionVerification.js'
import { validateLCHOverlayLicense } from './overlayAcquisitionLicense.js'
import {
  validateLCHOverlayPaidRoles,
  type LCHOverlayAuthorityPath
} from './overlayAcquisitionAuthority.js'
import {
  decodeUnverifiedLCHOverlayContext,
  type UnverifiedLCHOverlayContext
} from './overlayAcquisitionCodec.js'
import type {
  LCHBoundCovenantSettlement,
  LCHCovenantPurchaseEvidence
} from './overlayAcquisitionCovenantSettlementCore.js'
import { LCH_OVERLAY_COVENANT_MECHANISMS } from './overlayAcquisitionCovenantTerms.js'
import type {
  LCHCovenantDescriptor,
  LCHCovenantTermsInput,
  LCHCovenantTerms
} from './overlayAcquisitionCovenantTermsCore.js'
import type {
  ContentSource,
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'

export interface LCHCovenantAssessment {
  checkCurrent(): void
}
export interface LCHCovenantOriginalPurchase {
  request: OutputPurchasePrepare
  terms: OutputSignedPurchaseTerms
  seller: string
}
export interface LCHCovenantVerification<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment,
  O extends LCHCovenantOriginalPurchase
> {
  readonly id: string
  preparation(
    terms: OutputSignedPurchaseTerms,
    request: OutputPurchasePrepare,
    descriptor: D,
    signal: AbortSignal
  ): Promise<A>
  purchase(
    evidence: LCHCovenantPurchaseEvidence<D>,
    original: O,
    signal: AbortSignal
  ): Promise<LCHOverlayVerifiedCovenantPurchase>
  release(
    evidence: OutputReleaseEvidence,
    expected: OutputReleaseBinding,
    signal: AbortSignal
  ): Promise<LCHCovenantAssessment>
}
export interface LCHCovenantDomainOptions<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment,
  O extends LCHCovenantOriginalPurchase
> {
  original: Omit<
    LCHCovenantTermsInput<D>,
    'reader' | 'installedMechanisms' | 'verifier' | 'maximumCiphertextBytes'
  >
  source: ContentSource & { readonly id: string }
  verification: LCHCovenantVerification<D, A, O>
  wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>
  authorityPaths?: readonly LCHOverlayAuthorityPath[]
  authorityNetwork: RevocationObservation['network']
  revocations?: { readonly id: string; at(assessmentTime: string): RevocationSource }
  maximumCiphertextBytes: number
  clock(): string
  current(): boolean
}
export interface LCHCovenantDomainProfile<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment,
  O extends LCHCovenantOriginalPurchase
> {
  adapter: string
  terms(input: LCHCovenantTermsInput<D>): Promise<LCHCovenantTerms<D>>
  window(terms: LCHCovenantTerms<D>, packet: OutputSignedPurchaseTerms | null, now: string): void
  preparation(
    terms: LCHCovenantTerms<D>,
    assessment: A,
    challenge: OutputSignedPurchaseTerms,
    clock: () => string
  ): () => void
  evidence(bytes: Uint8Array): LCHCovenantPurchaseEvidence<D>
  bind(
    context: UnverifiedLCHOverlayContext,
    terms: LCHCovenantTerms<D>,
    packet: OutputSignedPurchaseTerms,
    delivered: OutputPurchaseEnvelope,
    txid: string
  ): LCHBoundCovenantSettlement<D>
  subject(candidate: OutputPurchaseSubmit, delivered: OutputPurchaseEnvelope): string
  original(input: LCHCovenantOriginalPurchase, candidate: OutputEvidence): O
}
interface Original {
  selectedAt: string
  header: Uint8Array
  offer: SignedObject
  request: Uint8Array
  prepare: Uint8Array
  descriptor: Uint8Array
  selection: Uint8Array
  paths: LCHOverlayAuthorityPath[]
}
const json = (value: unknown) => canonicalOutputJSON(value, { bytes: 4194304 })
const utf8 = (value: unknown) => new TextEncoder().encode(json(value))

/** Optional concrete fixed-render/standing-collector covenant BRC-198 domain. Creating it
 * never quotes, prepares, signs, pays or broadcasts. Its original bytes and
 * installation ID must be retained before constructing the durable buyer.
 * The durable purchase buyer installs this adapter only after protected custody is initialized. Preparation never constructs or funds a wallet action.
 */
export class LCHCovenantDomainCore<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment,
  O extends LCHCovenantOriginalPurchase
> {
  readonly id: string
  private readonly originalBytes: Uint8Array
  private readonly pins: (() => boolean)[]
  private readonly keyDelivery: WalletBRC78KeyRecovery
  private readonly maximumCiphertextBytes: number
  private readonly sourceId: string
  private readonly verificationId: string
  private readonly selectedAt: string
  private custody?: LCHOverlayPaidCustody
  private custodyOwner?: LCHOverlayObjectCustody
  private custodyTask?: Promise<LCHOverlayPaidCustody>
  protected constructor(
    private readonly ports: LCHCovenantDomainOptions<D, A, O>,
    private readonly profile: LCHCovenantDomainProfile<D, A, O>,
    retained?: Uint8Array
  ) {
    lchAssert(
      Number.isSafeInteger(ports.maximumCiphertextBytes) &&
        ports.maximumCiphertextBytes > 0 &&
        ports.maximumCiphertextBytes <= 536870912 &&
        typeof ports.source.id === 'string' &&
        ports.source.id.length > 0 &&
        typeof ports.verification.id === 'string' &&
        ports.verification.id.length > 0,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Finite content/proof installation is required'
    )
    lchAssert(
      ports.current.constructor.name !== 'AsyncFunction',
      'ERR_LCH_LICENSE',
      'Current access must be synchronous'
    )
    this.maximumCiphertextBytes = ports.maximumCiphertextBytes
    this.sourceId = ports.source.id
    this.verificationId = ports.verification.id
    this.selectedAt =
      retained === undefined
        ? outputU64(ports.clock()).toString()
        : outputU64(
            (decodeDeterministicCbor(retained) as unknown as Original).selectedAt
          ).toString()
    this.originalBytes = encodeDeterministicCbor({
      selectedAt: this.selectedAt,
      header: ports.original.header,
      offer: ports.original.offer as unknown as LCHValue,
      request: ports.original.request,
      prepare: utf8(ports.original.prepare),
      descriptor: utf8(ports.original.descriptor),
      selection: utf8(ports.original.selection),
      paths: (ports.authorityPaths ?? []) as unknown as LCHValue
    })
    lchAssert(
      this.originalBytes.length <= 4194304,
      'ERR_LCH_LICENSE',
      'Original covenant terms exceed protected custody bound'
    )
    this.id =
      'urn:bsv:lch-overlay-covenant:' +
      Utils.toHex(
        Hash.sha256(
          encodeDeterministicCbor({
            original: this.originalBytes,
            source: this.sourceId,
            verification: this.verificationId,
            maximumCiphertextBytes: this.maximumCiphertextBytes,
            authorityNetwork: ports.authorityNetwork,
            revocations: ports.revocations?.id ?? null,
            adapter: profile.adapter
          })
        )
      )
    this.keyDelivery = new WalletBRC78KeyRecovery(ports.wallet)
    this.pins = [
      pin(ports.source, 'read'),
      pin(ports.verification, 'preparation'),
      pin(ports.verification, 'purchase'),
      pin(ports.verification, 'release'),
      pin(ports.wallet, 'getPublicKey'),
      pin(ports.wallet, 'decrypt'),
      pin(ports, 'clock'),
      pin(ports, 'current'),
      pin(ports, 'source'),
      pin(ports, 'wallet'),
      pin(ports, 'verification'),
      pin(ports, 'revocations'),
      pin(ports, 'authorityNetwork')
    ]
    if (ports.revocations !== undefined)
      this.pins.push(pin(ports.revocations, 'at'), pin(ports.revocations, 'id'))
  }
  /** Complete both protected reservations before passing this adapter to a buyer.
   * A different object owner can never replace the installation in place.
   */
  async initializeCustody(objects: LCHOverlayObjectCustody): Promise<void> {
    await this.attachCustody(objects, true)
  }
  protected async attachCustody(
    objects: LCHOverlayObjectCustody,
    initialize: boolean
  ): Promise<void> {
    lchAssert(
      this.custodyOwner === undefined || this.custodyOwner === objects,
      'ERR_LCH_LICENSE',
      'Original LCH custody owner changed'
    )
    this.custodyOwner = objects
    if (this.custodyTask === undefined) {
      const original = decodeDeterministicCbor(this.originalBytes) as unknown as Original,
        acquire = JSON.parse(new TextDecoder().decode(original.prepare)) as OutputPurchasePrepare
      this.custodyTask = LCHOverlayPaidCustody[initialize ? 'initialize' : 'open'](
        objects,
        this.id,
        acquire.recipient,
        this.originalBytes
      )
    }
    this.custody = await this.custodyTask
    await this.custody.check()
  }
  private retained(): LCHOverlayPaidCustody {
    lchAssert(
      this.custody !== undefined,
      'ERR_LCH_LICENSE',
      'Original LCH custody is not initialized'
    )
    return this.custody
  }
  /** Complete original immutable bytes, suitable for protected local custody. */
  original(): Uint8Array {
    return this.originalBytes.slice()
  }
  private current(signal: AbortSignal): void {
    lchAssert(
      !signal.aborted &&
        this.pins.every(check => check()) &&
        this.ports.source.id === this.sourceId &&
        this.ports.verification.id === this.verificationId &&
        this.ports.current() === true,
      'ERR_LCH_LICENSE',
      'LCH domain cancelled, changed or inaccessible'
    )
  }
  protected async terms(signal: AbortSignal): Promise<{
    terms: LCHCovenantTerms<D>
    paths: LCHOverlayAuthorityPath[]
    verifier: LCHSignatureVerifier
    reader: LCHReader
  }> {
    this.current(signal)
    const original = decodeDeterministicCbor(this.originalBytes) as unknown as Original,
      parse = <T>(value: Uint8Array): T =>
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T,
      verifier = lchOverlaySignatureBudget(() => this.current(signal)),
      source: ContentSource = {
        read: async (...args) => {
          this.current(signal)
          const bytes = await this.ports.source.read(...args)
          this.current(signal)
          lchAssert(
            bytes instanceof Uint8Array && bytes.length <= this.maximumCiphertextBytes,
            'ERR_LCH_CONTENT_UNAVAILABLE',
            'Ciphertext source exceeded its local bound'
          )
          return bytes
        }
      },
      reader = new LCHReader(source, undefined, { verifier }),
      input = {
        header: original.header,
        offer: original.offer,
        request: original.request,
        prepare: parse<OutputPurchasePrepare>(original.prepare),
        descriptor: parse<D>(original.descriptor),
        selection: parse<LCHCovenantTermsInput<D>['selection']>(original.selection),
        installedMechanisms: new Set(LCH_OVERLAY_COVENANT_MECHANISMS),
        reader,
        verifier,
        maximumCiphertextBytes: this.maximumCiphertextBytes
      },
      terms = await this.profile.terms(input)
    this.current(signal)
    return { terms, paths: original.paths, verifier, reader }
  }
  async preflight(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): Promise<void> {
    this.current(signal)
    const ownedRequest = JSON.parse(json(request)) as OutputPurchasePrepare,
      ownedChallenge =
        challenge === null ? null : (JSON.parse(json(challenge)) as OutputSignedPurchaseTerms)
    await this.retained().check()
    await this.preflightTerms(ownedRequest, ownedChallenge, signal)
  }
  protected async preflightTerms(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): Promise<() => void> {
    const owned = JSON.parse(json(request)) as OutputPurchasePrepare,
      prepared = await this.terms(signal),
      { terms, paths, verifier } = prepared,
      now = this.ports.clock()
    lchAssert(
      json(owned) === json(terms.prepare),
      'ERR_LCH_LICENSE',
      'Original LCH request changed'
    )
    this.profile.window(terms, challenge, now)
    const identity = await this.ports.wallet.getPublicKey({ identityKey: true })
    this.current(signal)
    lchAssert(
      identity.publicKey === terms.prepare.recipient,
      'ERR_LCH_KEY',
      'Installed buyer wallet differs from signed LCH consent'
    )
    await validateLCHOverlayPaidRoles(
      terms,
      paths,
      outputU64(now),
      this.ports.authorityNetwork,
      verifier,
      this.ports.revocations?.at(now)
    )
    this.current(signal)
    let preparation = () => this.current(signal)
    if (challenge !== null) {
      const assessment = await this.ports.verification.preparation(
        challenge,
        terms.prepare,
        terms.descriptor,
        signal
      )
      const proof = this.assessment(assessment),
        contract = this.profile.preparation(terms, assessment, challenge, () => this.ports.clock())
      preparation = () => {
        proof()
        contract()
        this.current(signal)
      }
      preparation()
    }
    return preparation
  }
  /** The outer financial owner retains and rechecks this fence before effects. */
  protected async fundingPreflightCore(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms,
    signal: AbortSignal
  ): Promise<LCHCovenantAssessment> {
    this.current(signal)
    const ownedRequest = JSON.parse(json(request)) as OutputPurchasePrepare,
      ownedChallenge = JSON.parse(json(challenge)) as OutputSignedPurchaseTerms
    await this.retained().check()
    const checkCurrent = await this.preflightTerms(ownedRequest, ownedChallenge, signal)
    return { checkCurrent }
  }
  /** Read-only original candidate verification. It authenticates original
   * custody and the independently installed complete verifier without inventing
   * release evidence, accepting a License or applying a new-funding window. */
  protected async candidateBindingCore(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit,
    verify: (
      terms: LCHCovenantTerms<D>,
      original: O,
      signal: AbortSignal
    ) => Promise<LCHOverlayVerifiedCovenantPurchase>,
    checkInstalled: () => void,
    signal: AbortSignal
  ): Promise<LCHOverlayVerifiedCovenantPurchase> {
    this.current(signal)
    checkInstalled()
    const ownedRequest = parseOutputPurchasePrepare(JSON.parse(json(request))),
      ownedChallenge = parseOutputPurchaseTerms(JSON.parse(json(challenge))),
      ownedCandidate = parseOutputPurchaseSubmit(JSON.parse(json(candidate)))
    await this.retained().check()
    const prepared = await this.terms(signal)
    lchAssert(
      json(ownedRequest) === json(prepared.terms.prepare) &&
        ownedCandidate.acquisitionId === ownedChallenge.body.acquisitionId,
      'ERR_LCH_PAYMENT',
      'Original LCH candidate association changed'
    )
    const evidence = parseOutputEvidence({
        txid: ownedCandidate.txid,
        outputIndex: 0,
        beef: ownedCandidate.beef
      }),
      assessment = retainLCHCovenantPurchaseAssessment(
        await verify(
          prepared.terms,
          this.profile.original(
            { request: ownedRequest, terms: ownedChallenge, seller: prepared.terms.policy.seller },
            evidence
          ),
          signal
        )
      )
    await this.retained().check()
    const checkCurrent = () => {
      this.current(signal)
      checkInstalled()
      assessment.checkCurrent()
      checkInstalled()
      this.current(signal)
    }
    checkCurrent()
    return Object.freeze({ purchaseCommitment: assessment.purchaseCommitment, checkCurrent })
  }
  private assessment(input: { checkCurrent(): void }): () => void {
    const check = Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value as unknown
    lchAssert(
      typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
      'ERR_LCH_LICENSE',
      'Purchase verification guard must be synchronous'
    )
    return () => {
      const result: unknown = check.call(input)
      if (result instanceof Promise) void result.catch(() => undefined)
      lchAssert(
        result === undefined && input.checkCurrent === check,
        'ERR_LCH_LICENSE',
        'Purchase verification guard changed or did not finish'
      )
    }
  }
  async verify(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms,
    payment: OutputPurchaseSubmit,
    delivered: OutputPurchaseEnvelope,
    signal: AbortSignal
  ): Promise<void> {
    this.current(signal)
    const owned = {
      request: JSON.parse(json(request)) as OutputPurchasePrepare,
      challenge: JSON.parse(json(challenge)) as OutputSignedPurchaseTerms,
      payment: JSON.parse(json(payment)) as OutputPurchaseSubmit,
      delivered: JSON.parse(json(delivered)) as OutputPurchaseEnvelope
    }
    await this.retained().check()
    const prepared = await this.terms(signal)
    lchAssert(
      json(owned.request) === json(prepared.terms.prepare),
      'ERR_LCH_LICENSE',
      'Original LCH request changed'
    )
    await this.material(prepared, owned.challenge, owned.payment, owned.delivered, signal)
    this.current(signal)
    await this.retained().record(await lchOverlayCovenantEntitlementDigest(owned.delivered))
    this.current(signal)
  }
  async usable(delivered: OutputPurchaseEnvelope, signal: AbortSignal): Promise<boolean> {
    await this.verifiedMaterial(delivered, signal)
    return true
  }
  /** Explicit rendition boundary. Authentication and entitlement are checked
   * again; ciphertext chunks never escape as plaintext before AES-GCM success.
   */
  async playback(delivered: OutputPurchaseEnvelope, signal: AbortSignal): Promise<Uint8Array> {
    const { prepared, keys } = await this.verifiedMaterial(delivered, signal),
      plaintext = await prepared.reader.decrypt(prepared.terms.inspected, keys)
    this.current(signal)
    return plaintext
  }
  private async verifiedMaterial(deliveredInput: OutputPurchaseEnvelope, signal: AbortSignal) {
    this.current(signal)
    const delivered = JSON.parse(json(deliveredInput)) as OutputPurchaseEnvelope
    lchAssert(
      await this.retained().verified(await lchOverlayCovenantEntitlementDigest(delivered)),
      'ERR_LCH_LICENSE',
      'Delivered LCH entitlement has not been locally verified and retained'
    )
    const prepared = await this.terms(signal),
      context = await this.context(delivered),
      evidence = this.profile.evidence(context.purchaseEvidence!),
      bound = this.profile.bind(
        context,
        prepared.terms,
        evidence.terms,
        delivered,
        evidence.purchase.txid
      ),
      keys = await this.license(prepared, context, bound, signal, true)
    return { prepared, keys }
  }
  private context(delivered: OutputPurchaseEnvelope): Promise<UnverifiedLCHOverlayContext> {
    lchAssert(
      delivered.result.status === 'delivered',
      'ERR_LCH_LICENSE',
      'Delivered context is missing'
    )
    return decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(delivered.result.potatoes.body.secret, 2097152)),
      'listing-covenant'
    )
  }
  private async material(
    prepared: Awaited<ReturnType<LCHCovenantDomainCore<D, A, O>['terms']>>,
    challenge: OutputSignedPurchaseTerms,
    submission: OutputPurchaseSubmit,
    delivered: OutputPurchaseEnvelope,
    signal: AbortSignal
  ): Promise<Map<string, Uint8Array>> {
    const candidate = parseOutputPurchaseSubmit(submission),
      context = await this.context(delivered),
      bound = this.profile.bind(
        context,
        prepared.terms,
        challenge,
        delivered,
        this.profile.subject(candidate, delivered)
      ),
      raw = Beef.fromBinaryStrict(decodeOutputBytes(candidate.beef, 2097152)),
      target = raw.findTxid(candidate.txid)?.tx
    lchAssert(
      candidate.acquisitionId === challenge.body.acquisitionId &&
        (raw.atomicTxid === undefined || raw.atomicTxid === candidate.txid) &&
        target?.id('hex') === candidate.txid,
      'ERR_LCH_PAYMENT',
      'Original wallet transaction differs from the purchased subject'
    )
    const verified = retainLCHCovenantPurchaseAssessment(
      await this.ports.verification.purchase(
        bound.evidence,
        this.profile.original(
          {
            request: prepared.terms.prepare,
            terms: challenge,
            seller: prepared.terms.selected.seller
          },
          { txid: candidate.txid, outputIndex: 0, beef: candidate.beef }
        ),
        signal
      )
    )
    const purchase = () => verified.checkCurrent()
    purchase()
    lchAssert(
      bound.packet.body.purchaseCommitment === verified.purchaseCommitment,
      'ERR_LCH_PAYMENT',
      'Settlement differs from independently verified purchase commitment'
    )
    this.current(signal)
    const release = this.assessment(
      await this.ports.verification.release(
        bound.evidence.release,
        {
          chain: prepared.terms.prepare.listing.chain,
          txid: bound.evidence.purchase.txid,
          policy: challenge.body.releasePolicy
        },
        signal
      )
    )
    release()
    this.current(signal)
    const keys = await this.license(prepared, context, bound, signal)
    purchase()
    release()
    this.current(signal)
    return keys
  }
  private async license(
    prepared: Awaited<ReturnType<LCHCovenantDomainCore<D, A, O>['terms']>>,
    context: UnverifiedLCHOverlayContext,
    bound: LCHBoundCovenantSettlement<D>,
    signal: AbortSignal,
    locallyVerified = false
  ): Promise<Map<string, Uint8Array>> {
    return validateLCHOverlayLicense({
      ...prepared,
      context,
      requestId: prepared.terms.prepare.requestId,
      mode: 'listing-covenant',
      settlement: {
        id: bound.id,
        issuedAt: bound.packet.body.issuedAt,
        acceptedAt: bound.evidence.release.acceptedAt
      },
      selectedAt: this.selectedAt,
      authorityNetwork: this.ports.authorityNetwork,
      revocations: this.ports.revocations,
      keyDelivery: this.keyDelivery,
      locallyVerified,
      clock: () => this.ports.clock(),
      current: () => this.current(signal)
    })
  }
}
function pin<T extends object>(owner: T, key: keyof T): () => boolean {
  const method = owner[key]
  return () => owner[key] === method
}
