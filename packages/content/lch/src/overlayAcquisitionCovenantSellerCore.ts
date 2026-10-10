import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputPacketDigest,
  outputPacketPreimage,
  outputU64,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  Utils,
  verifyOutputPacket,
  type OutputCapabilitySelection,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit,
  type OutputReleaseBinding,
  type OutputReleaseEvidence,
  type OutputSignedPurchaseTerms,
  type WalletInterface
} from '@bsv/sdk'
import {
  retainLCHCovenantPurchaseAssessment,
  type LCHOverlayVerifiedCovenantPurchase
} from './overlayAcquisitionCovenantProof.js'
import { snapshotBytes, snapshotLCHRecord } from './boundary.js'
import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCH_IRI, LCH_MECHANISMS } from './constants.js'
import { LCHIssuer, LCHReader } from './core.js'
import { keyIdFor } from './encryption.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import { WalletBRC78KeyDelivery } from './keyDelivery.js'
import {
  validateLCHOverlayAuthority,
  validateLCHOverlayPaidRoles,
  type LCHOverlayAuthorityPath
} from './overlayAcquisitionAuthority.js'
import {
  encodeLCHOverlayContext,
  LCH_OVERLAY_LIMITS,
  LCH_OVERLAY_PROFILES
} from './overlayAcquisitionCodec.js'
import type { LCHCovenantSettlementBody } from './overlayAcquisitionCovenantSettlement.js'
import type {
  LCHCovenantLineage,
  LCHCovenantPurchaseEvidence
} from './overlayAcquisitionCovenantSettlementCore.js'
import { LCH_OVERLAY_COVENANT_MECHANISMS } from './overlayAcquisitionCovenantTerms.js'
import type {
  LCHCovenantDescriptor,
  LCHCovenantTerms,
  LCHCovenantTermsInput
} from './overlayAcquisitionCovenantTermsCore.js'
import type { LCHCovenantAssessment } from './overlayAcquisitionCovenantCore.js'
import type {
  LCHOverlayCovenantSellerCustody,
  LCHOverlayCovenantSellerProgress
} from './overlayAcquisitionCovenantSeller.js'
import { createLCHOverlayFixedRenderAgreement } from './overlayAcquisitionPolicy.js'
import { lchOverlaySignatureBudget } from './overlayAcquisitionVerification.js'
import { verifySignedObject } from './objects.js'
import type {
  ContentSource,
  KeyGrant,
  LCHSignatureVerifier,
  LCHSigner,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'

export interface LCHCovenantSellerListing<D extends LCHCovenantDescriptor> {
  header: Uint8Array
  offer: SignedObject
  descriptor: D
  lineage: LCHCovenantLineage<D>
  keys: readonly { keyId: Uint8Array; cek: Uint8Array }[]
  authorityPaths?: readonly LCHOverlayAuthorityPath[]
}
/** These installed ports execute full lineage/Script and release checks. No
 * catalogue field, wire signature or admission status implements them.
 */
export interface LCHCovenantSellerVerification<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment
> {
  readonly id: string
  lineage(
    lineage: LCHCovenantLineage<D>,
    expected: { request: OutputPurchasePrepare; descriptor: D },
    signal: AbortSignal
  ): Promise<A>
  purchase(
    evidence: OutputEvidence,
    original: { request: OutputPurchasePrepare; terms: OutputSignedPurchaseTerms; seller: string },
    signal: AbortSignal
  ): Promise<LCHOverlayVerifiedCovenantPurchase>
  release(
    evidence: OutputReleaseEvidence,
    expected: OutputReleaseBinding,
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
}
export interface LCHCovenantSellerOptions<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment
> {
  id: string
  catalogue: {
    load(request: OutputPurchasePrepare, signal: AbortSignal): Promise<LCHCovenantSellerListing<D>>
  }
  source: ContentSource
  sellerSigner: LCHSigner
  issuerSigner: LCHSigner
  issuerWallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>
  verification: LCHCovenantSellerVerification<D, A>
  authorityNetwork: RevocationObservation['network']
  revocations?: { readonly id: string; at(time: string): RevocationSource }
  maximumCiphertextBytes: number
  purchaseSeconds: string
  clock(): string
  current(): boolean
}
export interface LCHCovenantSellerProfile<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment
> {
  adapter: string
  terms(input: LCHCovenantTermsInput<D>): Promise<LCHCovenantTerms<D>>
  window(terms: LCHCovenantTerms<D>, packet: OutputSignedPurchaseTerms | null, now: string): void
  promise(terms: LCHCovenantTerms<D>, packet: OutputSignedPurchaseTerms): OutputSignedPurchaseTerms
  listingId(descriptor: D): string
  preparation(
    terms: LCHCovenantTerms<D>,
    assessment: A,
    clock: () => string,
    purchaseUntil: string
  ): () => void
}
interface Material {
  version: 1
  installation: string
  selectedAt: string
  header: Uint8Array
  offer: SignedObject
  request: Uint8Array
  prepare: Uint8Array
  descriptor: Uint8Array
  lineage: Uint8Array
  selection: Uint8Array
  paths: LCHOverlayAuthorityPath[]
  keys: { keyId: Uint8Array; cek: Uint8Array }[]
}
const json = (value: unknown) => canonicalOutputJSON(value, { bytes: 4194304 })
const utf8 = (value: unknown) => new TextEncoder().encode(json(value))
const own = <T>(value: T): T => JSON.parse(json(value)) as T
const parse = <T>(value: Uint8Array): T =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T
const bytes = (value: string) => Uint8Array.from(Utils.toArray(value, 'hex'))

/** Pure concrete C issuer. Preparation retains complete private key material;
 * issuance uses the native owner's original candidate and accepted obligation.
 * This adapter never signs a wallet action, broadcasts, admits or collects an
 * HTTP payment. First-result byte retention belongs to the coordinator.
 */
export class LCHCovenantSellerCore<
  D extends LCHCovenantDescriptor,
  A extends LCHCovenantAssessment
> {
  readonly id: string
  private readonly installation: string
  private readonly seller: string
  private readonly issuerIdentity: string
  private readonly issuer: LCHIssuer
  private readonly delivery: WalletBRC78KeyDelivery
  private readonly pins: (() => boolean)[]
  protected constructor(
    private readonly ports: LCHCovenantSellerOptions<D, A>,
    private readonly profile: LCHCovenantSellerProfile<D, A>
  ) {
    this.seller = toHex(ports.sellerSigner.identityKey)
    this.issuerIdentity = toHex(ports.issuerSigner.identityKey)
    lchAssert(
      ports.id.length > 0 &&
        ports.verification.id.length > 0 &&
        outputU64(ports.purchaseSeconds) > 0n &&
        Number.isSafeInteger(ports.maximumCiphertextBytes) &&
        ports.maximumCiphertextBytes > 0 &&
        ports.maximumCiphertextBytes <= 536870912 &&
        ports.current.constructor.name !== 'AsyncFunction',
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Finite synchronous seller installation is required'
    )
    this.installation = Utils.toHex(
      Hash.sha256(
        utf8({
          domain: 'urn:bsv:lch-covenant-seller-installation/1',
          id: ports.id,
          seller: this.seller,
          issuer: this.issuerIdentity,
          verification: ports.verification.id,
          authorityNetwork: ports.authorityNetwork,
          revocations: ports.revocations?.id ?? null,
          maximumCiphertextBytes: ports.maximumCiphertextBytes,
          purchaseSeconds: ports.purchaseSeconds,
          adapter: profile.adapter
        })
      )
    )
    this.id = 'urn:bsv:lch-covenant-seller:' + this.installation
    this.issuer = new LCHIssuer(ports.issuerSigner)
    this.delivery = new WalletBRC78KeyDelivery(ports.issuerWallet)
    this.pins = [
      pin(ports, 'id'),
      pin(ports, 'catalogue'),
      pin(ports.catalogue, 'load'),
      pin(ports, 'source'),
      pin(ports.source, 'read'),
      pin(ports, 'sellerSigner'),
      pin(ports.sellerSigner, 'sign'),
      pin(ports, 'issuerSigner'),
      pin(ports.issuerSigner, 'sign'),
      pin(ports, 'issuerWallet'),
      pin(ports.issuerWallet, 'getPublicKey'),
      pin(ports.issuerWallet, 'encrypt'),
      pin(ports.issuerWallet, 'decrypt'),
      pin(ports, 'verification'),
      pin(ports.verification, 'id'),
      pin(ports.verification, 'lineage'),
      pin(ports.verification, 'purchase'),
      pin(ports.verification, 'release'),
      pin(ports, 'authorityNetwork'),
      pin(ports, 'revocations'),
      pin(ports, 'maximumCiphertextBytes'),
      pin(ports, 'purchaseSeconds'),
      pin(ports, 'clock'),
      pin(ports, 'current')
    ]
    if (ports.revocations !== undefined)
      this.pins.push(pin(ports.revocations, 'id'), pin(ports.revocations, 'at'))
  }
  isCurrent(_original?: LCHOverlayCovenantSellerCustody['original']): boolean {
    if (
      !this.pins.every(check => check()) ||
      toHex(this.ports.sellerSigner.identityKey) !== this.seller ||
      toHex(this.ports.issuerSigner.identityKey) !== this.issuerIdentity
    )
      return false
    const current: unknown = this.ports.current()
    if (current instanceof Promise) void current.catch(() => undefined)
    return current === true
  }
  private check(signal?: AbortSignal): void {
    lchAssert(
      !signal?.aborted && this.isCurrent(),
      'ERR_LCH_LICENSE',
      'Seller installation changed, cancelled or inaccessible'
    )
  }
  private assessment(input: { checkCurrent(): void }): () => void {
    const check: unknown = Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value
    lchAssert(
      typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
      'ERR_LCH_LICENSE',
      'Seller proof guard must be synchronous'
    )
    return () => {
      const result: unknown = check.call(input)
      if (result instanceof Promise) void result.catch(() => undefined)
      lchAssert(
        result === undefined && input.checkCurrent === check,
        'ERR_LCH_LICENSE',
        'Seller proof guard changed or did not finish'
      )
    }
  }
  private material(encoded: string): Material {
    const data = Uint8Array.from(decodeOutputBytes(encoded, 4194304)),
      record = snapshotLCHRecord(
        decodeDeterministicCbor(data),
        'Retained covenant seller material'
      ),
      value = record as unknown as Material
    lchAssert(
      Object.keys(record)
        .sort((a, b) => Number(a > b) - Number(a < b))
        .join(',') ===
        'descriptor,header,installation,keys,lineage,offer,paths,prepare,request,selectedAt,selection,version' &&
        value.version === 1 &&
        value.installation === this.installation &&
        [
          value.header,
          value.request,
          value.prepare,
          value.descriptor,
          value.lineage,
          value.selection
        ].every(item => item instanceof Uint8Array) &&
        Array.isArray(value.paths) &&
        value.paths.length <= 128 &&
        Array.isArray(value.keys) &&
        value.keys.length > 0 &&
        value.keys.length <= 256,
      'ERR_LCH_CBOR',
      'Original covenant seller material differs'
    )
    outputU64(value.selectedAt)
    lchAssert(
      toHex(encodeDeterministicCbor(value as unknown as LCHValue)) === toHex(data),
      'ERR_LCH_CBOR',
      'Seller material is not exact CBOR'
    )
    return value
  }
  private async terms(
    material: Material,
    verifier: LCHSignatureVerifier,
    signal: AbortSignal
  ): Promise<LCHCovenantTerms<D>> {
    this.check(signal)
    const terms = await this.profile.terms({
      header: material.header,
      offer: material.offer,
      request: material.request,
      prepare: parse(material.prepare),
      descriptor: parse(material.descriptor),
      selection: parse(material.selection),
      installedMechanisms: new Set(LCH_OVERLAY_COVENANT_MECHANISMS),
      maximumCiphertextBytes: this.ports.maximumCiphertextBytes,
      verifier,
      reader: new LCHReader(
        {
          read: async (...args) => {
            this.check(signal)
            const result = await this.ports.source.read(...args)
            this.check(signal)
            lchAssert(
              result instanceof Uint8Array && result.length <= this.ports.maximumCiphertextBytes,
              'ERR_LCH_CONTENT_UNAVAILABLE',
              'Seller ciphertext exceeds bound'
            )
            return result
          }
        },
        undefined,
        { verifier }
      )
    })
    this.check(signal)
    lchAssert(
      terms.policy.seller === this.seller &&
        terms.offer.body.licenseIssuer instanceof Uint8Array &&
        toHex(terms.offer.body.licenseIssuer) === this.issuerIdentity,
      'ERR_LCH_AUTHORITY',
      'Seller or License issuer differs'
    )
    return terms
  }
  private async keys(
    material: Material,
    terms: LCHCovenantTerms<D>,
    signal: AbortSignal
  ): Promise<void> {
    const required = new Set(terms.encryption.keyPeriods.map(period => toHex(period.keyId)))
    lchAssert(material.keys.length === required.size, 'ERR_LCH_KEY', 'Whole-Asset key set differs')
    await sequence(material.keys, async key => {
      this.check(signal)
      lchAssert(
        key.keyId instanceof Uint8Array &&
          key.keyId.length === 32 &&
          key.cek instanceof Uint8Array &&
          key.cek.length === 32 &&
          required.delete(toHex(key.keyId)) &&
          toHex(await keyIdFor(key.cek)) === toHex(key.keyId),
        'ERR_LCH_KEY',
        'Retained covenant CEK differs'
      )
      this.check(signal)
    })
  }
  private async evidence(material: Material) {
    const objects = new Map<string, { type: 'offer' | 'authority'; object: SignedObject }>()
    const add = async (type: 'offer' | 'authority', object: SignedObject) => {
      const id = type + '\0' + toHex(await objectId(type, object.body))
      objects.set(id, { type, object })
    }
    await add('offer', material.offer)
    await sequence(material.paths, path =>
      sequence(path.chain, authority => add('authority', authority))
    )
    return [...objects].sort(([a], [b]) => Number(a > b) - Number(a < b)).map(([, value]) => value)
  }
  private async capacity(material: Material, terms: LCHCovenantTerms<D>): Promise<number> {
    const evidence = await this.evidence(material),
      agreement = await createLCHOverlayFixedRenderAgreement(terms.policy),
      selection = parse<OutputCapabilitySelection>(material.selection),
      // Worst supported key payload is 64 KiB. Three lineage sizes cover the
      // original package and its repeated base64 commitment in signed terms.
      // Two complete request envelopes cover candidate/consent framing; 384 KiB
      // covers bounded release evidence, License and settlement framing.
      allowance =
        393216 +
        material.lineage.length * 3 +
        selection.profile.maxRequestBytes * 2 +
        encodeDeterministicCbor(evidence as unknown as LCHValue).length +
        (agreement.inline as Uint8Array).length +
        material.keys.length * 65536
    await encodeLCHOverlayContext(
      {
        version: 1,
        evidence,
        license: { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
        settlement: utf8({ version: 1 }),
        purchaseEvidence: utf8({ version: 1 })
      },
      'listing-covenant'
    )
    lchAssert(
      allowance <= LCH_OVERLAY_LIMITS.contextBytes &&
        Math.ceil(allowance / 3) * 4 + 262144 <= selection.profile.maxResponseBytes,
      'ERR_LCH_DELIVERY',
      'Advertised request/response bounds cannot reserve complete covenant delivery'
    )
    return allowance
  }
  async prepare(
    request: OutputPurchasePrepare,
    selection: OutputCapabilitySelection,
    signal: AbortSignal
  ) {
    this.check(signal)
    request = parseOutputPurchasePrepare(own(request))
    selection = own(selection)
    const selectedAt = outputU64(this.ports.clock()).toString(),
      listing = await this.ports.catalogue.load(own(request), signal)
    this.check(signal)
    const retained = encodeDeterministicCbor({
      version: 1,
      installation: this.installation,
      selectedAt,
      header: snapshotBytes(listing.header, 'Seller Header'),
      offer: listing.offer as unknown as LCHValue,
      request: Uint8Array.from(decodeOutputBytes(request.request, 2097152)),
      prepare: utf8(request),
      descriptor: utf8(listing.descriptor),
      lineage: utf8(listing.lineage),
      selection: utf8(selection),
      paths: (listing.authorityPaths ?? []) as unknown as LCHValue,
      keys: listing.keys.map(key => ({
        keyId: snapshotBytes(key.keyId, 'Seller Key ID'),
        cek: snapshotBytes(key.cek, 'Seller CEK')
      }))
    })
    lchAssert(
      retained.length <= 4194304,
      'ERR_LCH_CBOR',
      'Complete private material exceeds reservation bound'
    )
    const material = this.material(Utils.toBase64(retained)),
      verifier = lchOverlaySignatureBudget(() => this.check(signal)),
      terms = await this.terms(material, verifier, signal)
    lchAssert(
      material.lineage.length <= 2097152,
      'ERR_LCH_DELIVERY',
      'Original lineage exceeds profile bound'
    )
    this.profile.window(terms, null, selectedAt)
    await validateLCHOverlayPaidRoles(
      terms,
      material.paths,
      outputU64(selectedAt),
      this.ports.authorityNetwork,
      verifier,
      this.ports.revocations?.at(selectedAt)
    )
    await this.keys(material, terms, signal)
    const identity = await this.ports.issuerWallet.getPublicKey({ identityKey: true })
    this.check(signal)
    lchAssert(identity.publicKey === this.issuerIdentity, 'ERR_LCH_KEY', 'Issuer wallet differs')
    const lineage = await this.ports.verification.lineage(
        parse(material.lineage),
        { request: own(request), descriptor: own(terms.descriptor) },
        signal
      ),
      verified = this.assessment(lineage),
      maximumSecretBytes = await this.capacity(material, terms),
      proposed = outputU64(selectedAt) + outputU64(this.ports.purchaseSeconds),
      purchaseUntil =
        terms.notAfter !== undefined && proposed > terms.notAfter ? terms.notAfter : proposed,
      recovery = [86400n, terms.recoverySeconds, outputU64(terms.advertisedRecoverySeconds)].reduce(
        (a, b) => {
          if (a > b) return a
          return b
        },
        0n
      )
    lchAssert(purchaseUntil > outputU64(selectedAt), 'ERR_LCH_QUOTE', 'No purchase window remains')
    const contract = this.profile.preparation(
      terms,
      lineage,
      () => this.ports.clock(),
      purchaseUntil.toString()
    )
    contract()
    this.check(signal)
    verified()
    return {
      preparation: {
        terms: {
          domainEvidence: {
            schema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
            bytes: Utils.toBase64(material.lineage)
          },
          purchaseUntil: purchaseUntil.toString(),
          creationCutoff: purchaseUntil.toString(),
          minimumRecoverySeconds: recovery.toString()
        },
        schema: LCH_OVERLAY_PROFILES.acquisition,
        maximumSecretBytes,
        material: Utils.toBase64(retained)
      },
      validation: {
        checkCurrent: () => {
          this.check(signal)
          verified()
          contract()
        }
      }
    }
  }
  private async original(custody: LCHOverlayCovenantSellerCustody, signal: AbortSignal) {
    const material = this.material(custody.material),
      verifier = lchOverlaySignatureBudget(() => this.check(signal)),
      terms = await this.terms(material, verifier, signal),
      original = custody.original,
      selection = parse<OutputCapabilitySelection>(material.selection)
    this.profile.promise(terms, original.terms)
    lchAssert(
      json(original.request) === json(terms.prepare) &&
        outputU64(original.createdAt) >= outputU64(material.selectedAt) &&
        outputU64(original.createdAt) < outputU64(original.terms.body.purchaseUntil) &&
        json(original.capability.manifest) === json(selection.manifest) &&
        original.capability.digest === selection.digest &&
        original.capability.service === terms.prepare.topic &&
        original.capability.profile === selection.profile.id &&
        custody.schema === LCH_OVERLAY_PROFILES.acquisition &&
        original.terms.body.domainEvidence.bytes === Utils.toBase64(material.lineage) &&
        custody.maximumSecretBytes === (await this.capacity(material, terms)),
      'ERR_LCH_LICENSE',
      'Retained original covenant reservation differs'
    )
    return { material, verifier, terms, selection }
  }
  private purchaseEvidence(
    custody: LCHOverlayCovenantSellerCustody,
    material: Material,
    candidate: OutputPurchaseSubmit,
    release: OutputReleaseEvidence
  ): LCHCovenantPurchaseEvidence<D> {
    lchAssert(
      candidate.acquisitionId === custody.original.terms.body.acquisitionId,
      'ERR_LCH_PAYMENT',
      'Purchase names another original request'
    )
    return {
      version: 1,
      lineage: parse(material.lineage),
      purchase: { txid: candidate.txid, outputIndex: 0, beef: candidate.beef },
      terms: own(custody.original.terms),
      release: own(release)
    }
  }
  async verify(
    candidate: OutputPurchaseSubmit,
    custody: LCHOverlayCovenantSellerCustody,
    signal: AbortSignal
  ) {
    this.check(signal)
    candidate = parseOutputPurchaseSubmit(own(candidate))
    custody = own(custody)
    const retained = await this.original(custody, signal)
    canonicalOutputJSON(candidate, { bytes: retained.selection.profile.maxRequestBytes })
    lchAssert(
      candidate.acquisitionId === custody.original.terms.body.acquisitionId,
      'ERR_LCH_PAYMENT',
      'Purchase names another original request'
    )
    const evidence = { txid: candidate.txid, outputIndex: 0, beef: candidate.beef },
      verified = retainLCHCovenantPurchaseAssessment(
        await this.ports.verification.purchase(
          evidence,
          {
            request: own(custody.original.request),
            terms: own(custody.original.terms),
            seller: this.seller
          },
          signal
        )
      )
    this.check(signal)
    verified.checkCurrent()
    return {
      purchaseCommitment: verified.purchaseCommitment,
      checkCurrent: () => {
        this.check(signal)
        verified.checkCurrent()
      }
    }
  }
  async issue(
    custody: LCHOverlayCovenantSellerCustody,
    progress: LCHOverlayCovenantSellerProgress,
    release: OutputReleaseEvidence,
    signal: AbortSignal,
    candidate?: OutputPurchaseSubmit
  ): Promise<string> {
    this.check(signal)
    custody = own(custody)
    progress = own(progress)
    release = own(release)
    lchAssert(
      candidate !== undefined,
      'ERR_LCH_PAYMENT',
      'Complete retained candidate is required for covenant issuance'
    )
    candidate = parseOutputPurchaseSubmit(own(candidate))
    const { material, verifier, terms, selection } = await this.original(custody, signal),
      original = custody.original
    canonicalOutputJSON(candidate, { bytes: selection.profile.maxRequestBytes })
    lchAssert(
      progress.status === 'admitted-delivery-pending' &&
        progress.admission !== null &&
        progress.txid === candidate.txid &&
        progress.recoveryUntil === original.terms.body.recoveryUntil,
      'ERR_LCH_PAYMENT',
      'Issuance requires the original admitted purchase'
    )
    const evidence = this.purchaseEvidence(custody, material, candidate, release),
      verified = retainLCHCovenantPurchaseAssessment(
        await this.ports.verification.purchase(
          evidence.purchase,
          { request: own(original.request), terms: own(original.terms), seller: this.seller },
          signal
        )
      ),
      released = this.assessment(
        await this.ports.verification.release(
          own(release),
          {
            chain: terms.prepare.listing.chain,
            txid: candidate.txid,
            policy: own(original.terms.body.releasePolicy)
          },
          signal
        )
      ),
      issuedAt = outputU64(this.ports.clock()).toString(),
      purchase = () => verified.checkCurrent()
    lchAssert(
      outputU64(material.selectedAt) <= outputU64(progress.admission!.acceptedAt) &&
        outputU64(progress.admission!.acceptedAt) <= outputU64(release.acceptedAt) &&
        outputU64(release.acceptedAt) <= outputU64(issuedAt) &&
        (release.policy.kind !== 'local-admission' ||
          release.acceptedAt === progress.admission!.acceptedAt),
      'ERR_LCH_PAYMENT',
      'Original selection, admission, release and issuance chronology differs'
    )
    await sequence(
      [
        {
          actor: terms.binding.seller,
          capability: LCH_IRI + '#issueOffer',
          at: material.selectedAt
        },
        {
          actor: terms.binding.seller,
          capability: LCH_IRI + '#receivePayment',
          at: release.acceptedAt
        },
        {
          actor: this.ports.issuerSigner.identityKey,
          capability: LCH_IRI + '#issueLicense',
          at: issuedAt
        }
      ],
      role =>
        validateLCHOverlayAuthority(terms, role.actor, role.capability, material.paths, {
          now: outputU64(role.at),
          network: this.ports.authorityNetwork,
          verifier,
          revocationSource: this.ports.revocations?.at(role.at)
        })
    )
    await this.keys(material, terms, signal)
    purchase()
    released()
    this.check(signal)
    const body: LCHCovenantSettlementBody = {
        version: 1,
        seller: this.seller,
        buyer: original.request.recipient,
        requestId: original.request.requestId,
        offerId: original.request.termsDigest,
        assetId: original.request.assetId,
        dutyUid: terms.policy.dutyUid,
        acquisitionId: original.terms.body.acquisitionId,
        listingId: this.profile.listingId(terms.descriptor),
        previous: own(original.request.listing),
        successor: {
          chain: own(original.request.listing.chain),
          txid: candidate.txid,
          outputIndex: 0
        },
        txid: candidate.txid,
        purchaseCommitment: verified.purchaseCommitment,
        satoshis: terms.policy.satoshis.toString(),
        releasePolicy: own(release.policy),
        releaseEvidenceDigest: outputPacketDigest('release-evidence', release),
        issuedAt,
        recoveryUntil: original.terms.body.recoveryUntil
      },
      signature = await this.ports.sellerSigner.sign(
        Uint8Array.from(outputPacketPreimage('lch-covenant-settlement', body))
      ),
      settlement = { body, signature: Utils.toBase64(signature) },
      settlementId = outputPacketDigest('lch-covenant-settlement', body)
    lchAssert(
      verifyOutputPacket('lch-covenant-settlement', settlement, this.seller),
      'ERR_LCH_SIGNATURE',
      'Collector settlement signature differs'
    )
    purchase()
    released()
    this.check(signal)
    const keyGrants: KeyGrant[] = []
    await sequence(material.keys, async key => {
      const payload = await this.delivery.deliver(original.request.recipient, key.keyId, key.cek)
      lchAssert(
        toHex(payload.slice(4, 37)) === this.issuerIdentity,
        'ERR_LCH_KEY',
        'Key-delivery sender changed'
      )
      keyGrants.push({ keyId: key.keyId, delivery: LCH_MECHANISMS.brc78Key, payload })
      purchase()
      released()
      this.check(signal)
    })
    const license = await this.issuer.issueLicense({
        assetId: terms.inspected.assetId,
        offerId: bytes(original.request.termsDigest),
        requestId: bytes(original.request.requestId),
        issuer: this.ports.issuerSigner.identityKey,
        subject: terms.request.body.buyer as Uint8Array,
        issuedAt: outputU64(issuedAt),
        agreement: await createLCHOverlayFixedRenderAgreement(terms.policy),
        selection: { type: 'all' },
        keyGrants,
        encryption: terms.encryption,
        fulfillments: [
          {
            dutyUid: terms.policy.dutyUid,
            settlementProfile: LCH_OVERLAY_PROFILES.collectorSettlement,
            receiptIds: [bytes(settlementId)]
          }
        ],
        critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.collectorSettlement],
        extensions: {
          [LCH_OVERLAY_PROFILES.acquisition]: {
            version: 1,
            mode: 'listing-covenant',
            settlementId: bytes(settlementId)
          },
          [LCH_OVERLAY_PROFILES.collectorSettlement]: { version: 1 }
        }
      }),
      context = await encodeLCHOverlayContext(
        {
          version: 1,
          license,
          evidence: await this.evidence(material),
          settlement: utf8(settlement),
          purchaseEvidence: utf8(evidence)
        },
        'listing-covenant'
      )
    lchAssert(
      context.length <= custody.maximumSecretBytes,
      'ERR_LCH_DELIVERY',
      'Issued covenant context exceeds its original capacity'
    )
    await verifySignedObject('license', license, verifier, this.ports.issuerSigner.identityKey, {
      supportedCriticalIdentifiers: new Set([
        LCH_OVERLAY_PROFILES.acquisition,
        LCH_OVERLAY_PROFILES.collectorSettlement
      ])
    })
    purchase()
    released()
    this.check(signal)
    return Utils.toBase64(context)
  }
}
function pin<T extends object>(owner: T, key: keyof T): () => boolean {
  const value = owner[key]
  return () => owner[key] === value
}
function sequence<T>(items: readonly T[], action: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((pending, item) => pending.then(() => action(item)), Promise.resolve())
}
