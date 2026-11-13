import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  Utils,
  outputU64,
  type OutputChain,
  type OutputEvidence,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupAcquired,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type OutputReleaseBinding,
  type OutputReleaseEvidence,
  type WalletInterface
} from '@bsv/sdk'
import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCHReader } from './core.js'
import { lchOverlayPaidEntitlementDigest } from './overlayAcquisitionEntitlement.js'
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
  bindLCHOverlayPaidSettlement,
  decodeLCHOverlayPaymentEvidence,
  type LCHOverlayBoundPaidSettlement
} from './overlayAcquisitionSettlement.js'
import {
  LCH_OVERLAY_PAID_MECHANISMS,
  validateLCHOverlayPaidTerms,
  validateLCHOverlayPaidWindow,
  type LCHOverlayPaidTermsInput,
  type LCHOverlayPaidTerms
} from './overlayAcquisitionTerms.js'
import type {
  ContentSource,
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'

/** Locally installed proof boundaries. A remote seller report cannot implement
 * any of these ports. Reference composition uses SDK Script/SPV funding/listing
 * verification and retained SDK release-policy assessments.
 */
export interface LCHOverlayPaidVerification {
  readonly id: string
  funding(
    payment: OutputPaidLookupPayment,
    challenge: OutputPaidLookupChallenge,
    chain: OutputChain,
    signal: AbortSignal
  ): Promise<{
    operation: { funding: { chain: OutputChain; txid: string; outputIndex: number }; beef: string }
  }>
  listing(
    evidence: OutputEvidence,
    selected: OutputPaidLookupAcquire['listing'],
    signal: AbortSignal
  ): Promise<void>
  release(
    evidence: OutputReleaseEvidence,
    expected: OutputReleaseBinding,
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
}
export interface LCHOverlayPaidDomainOptions {
  original: Omit<
    LCHOverlayPaidTermsInput,
    'reader' | 'installedMechanisms' | 'verifier' | 'maximumCiphertextBytes'
  >
  source: ContentSource & { readonly id: string }
  verification: LCHOverlayPaidVerification
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
  acquire: Uint8Array
  selection: Uint8Array
  paths: LCHOverlayAuthorityPath[]
}
const json = (value: unknown) => canonicalOutputJSON(value, { bytes: 4194304 })
const utf8 = (value: unknown) => new TextEncoder().encode(json(value))

/** Optional concrete fixed-render/direct-collector BRC-198 domain. Creating it
 * never quotes, prepares, signs, pays or broadcasts. Its original bytes and
 * installation ID must be retained before constructing the durable buyer.
 * Generic buyer validation ports are structurally compatible with this class.
 */
export class LCHOverlayPaidDomain {
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
    private readonly ports: LCHOverlayPaidDomainOptions,
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
      acquire: utf8(ports.original.acquire),
      selection: utf8(ports.original.selection),
      paths: (ports.authorityPaths ?? []) as unknown as LCHValue
    })
    this.id =
      'urn:bsv:lch-overlay-paid:' +
      Utils.toHex(
        Hash.sha256(
          encodeDeterministicCbor({
            original: this.originalBytes,
            source: this.sourceId,
            verification: this.verificationId,
            maximumCiphertextBytes: this.maximumCiphertextBytes,
            authorityNetwork: ports.authorityNetwork,
            revocations: ports.revocations?.id ?? null,
            adapter: 'fixed-render-direct-collector/1'
          })
        )
      )
    this.keyDelivery = new WalletBRC78KeyRecovery(ports.wallet)
    this.pins = [
      pin(ports.source, 'read'),
      pin(ports.verification, 'funding'),
      pin(ports.verification, 'listing'),
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
  static async create(options: LCHOverlayPaidDomainOptions): Promise<LCHOverlayPaidDomain> {
    const domain = new LCHOverlayPaidDomain(options)
    await domain.preflightTerms(options.original.acquire, null, new AbortController().signal)
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
        acquire = JSON.parse(new TextDecoder().decode(original.acquire)) as OutputPaidLookupAcquire
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
    options: LCHOverlayPaidDomainOptions,
    retained: { id: string; original: Uint8Array },
    objects: LCHOverlayObjectCustody
  ): Promise<LCHOverlayPaidDomain> {
    const original = retained.original.slice(),
      domain = new LCHOverlayPaidDomain(options, original)
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
    terms: LCHOverlayPaidTerms
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
        acquire: parse<OutputPaidLookupAcquire>(original.acquire),
        selection: parse<LCHOverlayPaidTermsInput['selection']>(original.selection),
        installedMechanisms: new Set(LCH_OVERLAY_PAID_MECHANISMS),
        reader,
        verifier,
        maximumCiphertextBytes: this.maximumCiphertextBytes
      },
      terms = await validateLCHOverlayPaidTerms(input)
    this.current(signal)
    return { terms, paths: original.paths, verifier, reader }
  }
  async preflight(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge | null,
    signal: AbortSignal
  ): Promise<void> {
    await this.retained().check()
    await this.preflightTerms(request, challenge, signal)
  }
  private async preflightTerms(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge | null,
    signal: AbortSignal
  ): Promise<void> {
    const owned = JSON.parse(json(request)) as OutputPaidLookupAcquire,
      prepared = await this.terms(signal),
      { terms, paths, verifier } = prepared,
      now = this.ports.clock()
    lchAssert(
      json(owned) === json(terms.acquire),
      'ERR_LCH_LICENSE',
      'Original LCH request changed'
    )
    validateLCHOverlayPaidWindow(terms, challenge, now, terms.advertisedRecoverySeconds)
    const identity = await this.ports.wallet.getPublicKey({ identityKey: true })
    this.current(signal)
    lchAssert(
      identity.publicKey === terms.acquire.recipient,
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
  }
  async verify(
    request: OutputPaidLookupAcquire,
    challenge: OutputPaidLookupChallenge,
    payment: OutputPaidLookupPayment,
    delivered: OutputPaidLookupAcquired,
    signal: AbortSignal
  ): Promise<void> {
    await this.retained().check()
    const owned = {
        request: JSON.parse(json(request)) as OutputPaidLookupAcquire,
        challenge: JSON.parse(json(challenge)) as OutputPaidLookupChallenge,
        payment: JSON.parse(json(payment)) as OutputPaidLookupPayment,
        delivered: JSON.parse(json(delivered)) as OutputPaidLookupAcquired
      },
      prepared = await this.terms(signal)
    lchAssert(
      json(owned.request) === json(prepared.terms.acquire),
      'ERR_LCH_LICENSE',
      'Original LCH request changed'
    )
    await this.material(prepared, owned.challenge, owned.payment, owned.delivered, signal)
    this.current(signal)
    await this.retained().record(await lchOverlayPaidEntitlementDigest(owned.delivered))
    this.current(signal)
  }
  async usable(delivered: OutputPaidLookupAcquired, signal: AbortSignal): Promise<boolean> {
    await this.verifiedMaterial(delivered, signal)
    return true
  }
  /** Explicit rendition boundary. Authentication and entitlement are checked
   * again; ciphertext chunks never escape as plaintext before AES-GCM success.
   */
  async playback(delivered: OutputPaidLookupAcquired, signal: AbortSignal): Promise<Uint8Array> {
    const { prepared, keys } = await this.verifiedMaterial(delivered, signal),
      plaintext = await prepared.reader.decrypt(prepared.terms.inspected, keys)
    this.current(signal)
    return plaintext
  }
  private async verifiedMaterial(deliveredInput: OutputPaidLookupAcquired, signal: AbortSignal) {
    const delivered = JSON.parse(json(deliveredInput)) as OutputPaidLookupAcquired
    lchAssert(
      await this.retained().verified(await lchOverlayPaidEntitlementDigest(delivered)),
      'ERR_LCH_LICENSE',
      'Delivered LCH entitlement has not been locally verified and retained'
    )
    const prepared = await this.terms(signal),
      context = await this.context(delivered),
      paymentEvidence = decodeLCHOverlayPaymentEvidence(context.paymentEvidence!)
    const bound = bindLCHOverlayPaidSettlement(
        context,
        prepared.terms,
        paymentEvidence.challenge,
        {
          derivationPrefix: paymentEvidence.challenge.derivationPrefix,
          derivationSuffix: paymentEvidence.derivationSuffix,
          transaction: paymentEvidence.payment.beef
        },
        delivered
      ),
      keys = await this.license(prepared, context, bound, signal, true)
    return { prepared, keys }
  }
  private context(delivered: OutputPaidLookupAcquired): Promise<UnverifiedLCHOverlayContext> {
    lchAssert(delivered.result !== undefined, 'ERR_LCH_LICENSE', 'Delivered context is missing')
    return decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(delivered.result.context, 2097152)),
      'paid-lookup'
    )
  }
  private async material(
    prepared: Awaited<ReturnType<LCHOverlayPaidDomain['terms']>>,
    challenge: OutputPaidLookupChallenge,
    payment: OutputPaidLookupPayment,
    delivered: OutputPaidLookupAcquired,
    signal: AbortSignal
  ): Promise<Map<string, Uint8Array>> {
    const context = await this.context(delivered),
      bound = bindLCHOverlayPaidSettlement(context, prepared.terms, challenge, payment, delivered),
      funding = await this.ports.verification.funding(
        payment,
        challenge,
        prepared.terms.acquire.listing.chain,
        signal
      )
    this.current(signal)
    lchAssert(
      json(funding.operation.funding) === json(bound.packet.body.funding) &&
        funding.operation.beef === payment.transaction,
      'ERR_LCH_PAYMENT',
      'Independent funding proof differs'
    )
    await this.ports.verification.listing(
      delivered.result!.evidence,
      prepared.terms.acquire.listing,
      signal
    )
    this.current(signal)
    const assessment = await this.ports.verification.release(
      bound.evidence.release,
      {
        chain: prepared.terms.acquire.listing.chain,
        txid: bound.packet.body.funding.txid,
        policy: challenge.acceptancePolicy
      },
      signal
    )
    assessment.checkCurrent()
    this.current(signal)
    const keys = await this.license(prepared, context, bound, signal)
    assessment.checkCurrent()
    this.current(signal)
    return keys
  }
  private async license(
    prepared: Awaited<ReturnType<LCHOverlayPaidDomain['terms']>>,
    context: UnverifiedLCHOverlayContext,
    bound: LCHOverlayBoundPaidSettlement,
    signal: AbortSignal,
    locallyVerified = false
  ): Promise<Map<string, Uint8Array>> {
    return validateLCHOverlayLicense({
      ...prepared,
      context,
      requestId: prepared.terms.acquire.requestId,
      mode: 'paid-lookup',
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
