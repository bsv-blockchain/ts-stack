import {
  canonicalOutputJSON,
  Beef,
  parseOutputPurchaseSubmit,
  decodeOutputBytes,
  Hash,
  Utils,
  outputU64,
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
import { lchOverlayCovenantEntitlementDigest } from './overlayAcquisitionCovenantEntitlement.js'
import { LCHOverlayPaidCustody, type LCHOverlayObjectCustody } from './overlayAcquisitionCustody.js'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'
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
import {
  bindLCHOverlayCovenantSettlement,
  decodeLCHOverlayCovenantPurchaseEvidence,
  type LCHOverlayBoundCovenantSettlement,
  type LCHOverlayCovenantPurchaseEvidence
} from './overlayAcquisitionCovenantSettlement.js'
import {
  LCH_OVERLAY_COVENANT_MECHANISMS,
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantWindow,
  type LCHOverlayCovenantTermsInput,
  type LCHOverlayCovenantTerms
} from './overlayAcquisitionCovenantTerms.js'
import type {
  ContentSource,
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'

/** Installed independent BRC-197 and release proof boundaries. Remote packets
 * and collector signatures cannot implement these locally selected verifiers.
 */
export interface LCHOverlayCovenantVerification {
  readonly id: string
  preparation(
    terms: OutputSignedPurchaseTerms,
    request: OutputPurchasePrepare,
    descriptor: LCHOverlayCovenantTerms['descriptor'],
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
  purchase(
    evidence: LCHOverlayCovenantPurchaseEvidence,
    original: { request: OutputPurchasePrepare; terms: OutputSignedPurchaseTerms; seller: string },
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
  release(
    evidence: OutputReleaseEvidence,
    expected: OutputReleaseBinding,
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
}
export interface LCHOverlayCovenantDomainOptions {
  original: Omit<
    LCHOverlayCovenantTermsInput,
    'reader' | 'installedMechanisms' | 'verifier' | 'maximumCiphertextBytes'
  >
  source: ContentSource & { readonly id: string }
  verification: LCHOverlayCovenantVerification
  wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>
  authorityPaths?: readonly LCHOverlayAuthorityPath[]
  authorityNetwork: RevocationObservation['network']
  /** Resolve a locally retained/authenticated assessment for the exact role time.
   * A live status response must never be backdated for historical License use.
   */
  revocations?: { readonly id: string; at(assessmentTime: string): RevocationSource }
  /** Independently bound local maximum; checked before ciphertext retrieval. */
  maximumCiphertextBytes: number
  clock(): string
  current(): boolean
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
export class LCHOverlayCovenantDomain {
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
  private constructor(
    private readonly ports: LCHOverlayCovenantDomainOptions,
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
            adapter: 'fixed-render-standing-collector/1'
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
  static async create(options: LCHOverlayCovenantDomainOptions): Promise<LCHOverlayCovenantDomain> {
    const domain = new LCHOverlayCovenantDomain(options)
    await domain.preflightTerms(options.original.prepare, null, new AbortController().signal)
    return domain
  }
  /** Complete both protected reservations before passing this adapter to a buyer.
   * A different object owner can never replace the installation in place.
   */
  async initializeCustody(objects: LCHOverlayObjectCustody): Promise<void> {
    await this.attachCustody(objects, true)
  }
  private async attachCustody(
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
  /** Read-only reopen against independently retained identity and original bytes.
   * Offer expiry never turns a funded obligation into a new acquisition.
   */
  static async open(
    options: LCHOverlayCovenantDomainOptions,
    retained: { id: string; original: Uint8Array },
    objects: LCHOverlayObjectCustody
  ): Promise<LCHOverlayCovenantDomain> {
    const original = retained.original.slice(),
      domain = new LCHOverlayCovenantDomain(options, original)
    lchAssert(
      domain.id === retained.id && toHex(domain.originalBytes) === toHex(original),
      'ERR_LCH_LICENSE',
      'Retained LCH domain installation differs'
    )
    await domain.attachCustody(objects, false)
    await domain.terms(new AbortController().signal)
    return domain
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
  private async terms(signal: AbortSignal): Promise<{
    terms: LCHOverlayCovenantTerms
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
        descriptor: parse<LCHOverlayCovenantTermsInput['descriptor']>(original.descriptor),
        selection: parse<LCHOverlayCovenantTermsInput['selection']>(original.selection),
        installedMechanisms: new Set(LCH_OVERLAY_COVENANT_MECHANISMS),
        reader,
        verifier,
        maximumCiphertextBytes: this.maximumCiphertextBytes
      },
      terms = await validateLCHOverlayCovenantTerms(input)
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
  private async preflightTerms(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): Promise<void> {
    const owned = JSON.parse(json(request)) as OutputPurchasePrepare,
      prepared = await this.terms(signal),
      { terms, paths, verifier } = prepared,
      now = this.ports.clock()
    lchAssert(
      json(owned) === json(terms.prepare),
      'ERR_LCH_LICENSE',
      'Original LCH request changed'
    )
    validateLCHOverlayCovenantWindow(terms, challenge, now)
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
    if (challenge !== null) {
      const assessment = await this.ports.verification.preparation(
        challenge,
        terms.prepare,
        terms.descriptor,
        signal
      )
      this.assessment(assessment)()
      this.current(signal)
    }
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
      evidence = decodeLCHOverlayCovenantPurchaseEvidence(context.purchaseEvidence!),
      bound = bindLCHOverlayCovenantSettlement(
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
    prepared: Awaited<ReturnType<LCHOverlayCovenantDomain['terms']>>,
    challenge: OutputSignedPurchaseTerms,
    submission: OutputPurchaseSubmit,
    delivered: OutputPurchaseEnvelope,
    signal: AbortSignal
  ): Promise<Map<string, Uint8Array>> {
    const candidate = parseOutputPurchaseSubmit(submission),
      context = await this.context(delivered),
      bound = bindLCHOverlayCovenantSettlement(
        context,
        prepared.terms,
        challenge,
        delivered,
        candidate.txid
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
    const purchase = this.assessment(
      await this.ports.verification.purchase(
        bound.evidence,
        {
          request: prepared.terms.prepare,
          terms: challenge,
          seller: prepared.terms.selected.seller
        },
        signal
      )
    )
    purchase()
    this.current(signal)
    const release = this.assessment(
      await this.ports.verification.release(
        bound.evidence.release,
        {
          chain: prepared.terms.prepare.listing.chain,
          txid: candidate.txid,
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
    prepared: Awaited<ReturnType<LCHOverlayCovenantDomain['terms']>>,
    context: UnverifiedLCHOverlayContext,
    bound: LCHOverlayBoundCovenantSettlement,
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
