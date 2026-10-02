import {
  canonicalOutputJSON,
  decodeOutputBytes,
  outputPacketDigest,
  outputPacketPreimage,
  outputU64,
  Utils,
  verifyOutputPacket,
  type OutputCapabilitySelection,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type OutputRetainedCapability,
  type OutputEvidence,
  type OutputReleaseEvidence,
  type OutputWalletFundingOperation,
  type WalletInterface
} from '@bsv/sdk'
import { encodeDeterministicCbor, decodeDeterministicCbor } from './cbor.js'
import { LCHIssuer, LCHReader } from './core.js'
import { LCH_IRI, LCH_MECHANISMS } from './constants.js'
import { lchAssert } from './errors.js'
import { keyIdFor } from './encryption.js'
import { objectId, toHex } from './hash.js'
import { snapshotBytes, snapshotLCHRecord } from './boundary.js'
import { WalletBRC78KeyDelivery } from './keyDelivery.js'
import { lchOverlaySignatureBudget } from './overlayAcquisitionVerification.js'
import { verifySignedObject } from './objects.js'
import { createLCHOverlayFixedRenderAgreement } from './overlayAcquisitionPolicy.js'
import {
  validateLCHOverlayPaidRoles,
  validateLCHOverlayAuthority,
  type LCHOverlayAuthorityPath
} from './overlayAcquisitionAuthority.js'
import {
  LCH_OVERLAY_PAID_MECHANISMS,
  validateLCHOverlayPaidTerms,
  validateLCHOverlayPaidWindow,
  validateLCHOverlayPaidPromise,
  type LCHOverlayPaidTerms
} from './overlayAcquisitionTerms.js'
import { LCH_OVERLAY_PROFILES, encodeLCHOverlayContext } from './overlayAcquisitionCodec.js'
import type { LCHOverlayPaidVerification } from './overlayAcquisitionPaid.js'
import type {
  ContentSource,
  LCHSignatureVerifier,
  LCHSigner,
  LCHValue,
  RevocationObservation,
  RevocationSource,
  SignedObject,
  KeyGrant
} from './types.js'

/** Local catalogue selection. The CEKs and original terms become protected
 * off-chain material owned by the acquisition coordinator, never public output
 * context. C is the host's independently verified chain-context type.
 */
export interface LCHOverlaySellerListing<C> {
  header: Uint8Array
  offer: SignedObject
  evidence: OutputEvidence
  verificationContext: C
  keys: readonly { keyId: Uint8Array; cek: Uint8Array }[]
  authorityPaths?: readonly LCHOverlayAuthorityPath[]
}
export interface LCHOverlaySellerOriginal {
  request: OutputPaidLookupAcquire
  challenge: OutputPaidLookupChallenge
  capability: OutputRetainedCapability
  evidence: OutputEvidence
  schema: string
}
export interface LCHOverlaySellerProgress {
  challenge: OutputPaidLookupChallenge
  phase: string
  candidate: { payment: OutputPaidLookupPayment; verdict: string } | null
  funding: { operation: OutputWalletFundingOperation; acceptance: OutputReleaseEvidence } | null
  walletReceipt: { operationId: string } | null
  delivery: { preparedAt: string } | null
  recoveryUntil: string
}
export interface LCHOverlayPaidSellerOptions<C> {
  /** Stable installation identity, independent of discovery/catalogue presence. */
  id: string
  catalogue: {
    load(request: OutputPaidLookupAcquire, signal: AbortSignal): Promise<LCHOverlaySellerListing<C>>
  }
  source: ContentSource
  sellerSigner: LCHSigner
  issuerSigner: LCHSigner
  issuerWallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>
  verification: LCHOverlayPaidVerification
  /** Independently reconcile the exact original native credit. A serialized
   * walletReceipt field by itself is never the implementation of this port.
   */
  credited(
    operation: OutputWalletFundingOperation,
    operationId: string,
    signal: AbortSignal
  ): Promise<void>
  authorityNetwork: RevocationObservation['network']
  revocations?: { at(time: string): RevocationSource }
  maximumCiphertextBytes: number
  quoteSeconds: string
  /** Bounded BRC-105 prefix from a local cryptographic nonce source. */
  derivationPrefix(): string
  clock(): string
  current(): boolean
}
interface Material {
  version: 1
  installation: string
  selectedAt: string
  header: Uint8Array
  offer: SignedObject
  request: Uint8Array
  acquire: Uint8Array
  selection: Uint8Array
  paths: LCHOverlayAuthorityPath[]
  keys: { keyId: Uint8Array; cek: Uint8Array }[]
}
const json = (value: unknown) => canonicalOutputJSON(value)
const utf8 = (value: unknown) => new TextEncoder().encode(json(value))
const parse = <T>(value: Uint8Array): T =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as T
const bytes = (value: string) => Uint8Array.from(Utils.toArray(value, 'hex'))

/** Concrete seller domain for the protected PrivateAcquisitionCoordinator port.
 * Financial effects and first-result byte retention stay in that coordinator.
 * This class issues only from retained, independently verified original payment,
 * credit and release evidence; it never charges, credits or broadcasts.
 */
export class LCHOverlayPaidSeller<C> {
  private readonly identity: string
  private readonly issuerIdentity: string
  private readonly installation: string
  private readonly pins: (() => boolean)[]
  private readonly issuer: LCHIssuer
  private readonly delivery: WalletBRC78KeyDelivery
  constructor(private readonly ports: LCHOverlayPaidSellerOptions<C>) {
    this.identity = toHex(ports.sellerSigner.identityKey)
    this.issuerIdentity = toHex(ports.issuerSigner.identityKey)
    this.installation = ports.id
    lchAssert(
      ports.id.length > 0 &&
        outputU64(ports.quoteSeconds) > 0n &&
        Number.isSafeInteger(ports.maximumCiphertextBytes) &&
        ports.maximumCiphertextBytes > 0 &&
        ports.maximumCiphertextBytes <= 536870912,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Finite seller installation is required'
    )
    this.issuer = new LCHIssuer(ports.issuerSigner)
    this.delivery = new WalletBRC78KeyDelivery(ports.issuerWallet)
    this.pins = [
      pin(ports, 'id'),
      pin(ports, 'catalogue'),
      pin(ports.catalogue, 'load'),
      pin(ports, 'source'),
      pin(ports.source, 'read'),
      pin(ports, 'verification'),
      pin(ports.verification, 'id'),
      pin(ports.verification, 'funding'),
      pin(ports.verification, 'listing'),
      pin(ports.verification, 'release'),
      pin(ports, 'sellerSigner'),
      pin(ports.sellerSigner, 'sign'),
      pin(ports, 'issuerSigner'),
      pin(ports.issuerSigner, 'sign'),
      pin(ports, 'issuerWallet'),
      pin(ports.issuerWallet, 'getPublicKey'),
      pin(ports.issuerWallet, 'encrypt'),
      pin(ports.issuerWallet, 'decrypt'),
      pin(ports, 'credited'),
      pin(ports, 'clock'),
      pin(ports, 'current'),
      pin(ports, 'derivationPrefix'),
      pin(ports, 'maximumCiphertextBytes'),
      pin(ports, 'quoteSeconds'),
      pin(ports, 'authorityNetwork'),
      pin(ports, 'revocations')
    ]
    if (ports.revocations !== undefined) this.pins.push(pin(ports.revocations, 'at'))
  }
  private check(signal?: AbortSignal): void {
    lchAssert(
      !signal?.aborted && this.isCurrent(),
      'ERR_LCH_LICENSE',
      'Seller installation cancelled, changed or inaccessible'
    )
  }
  /** Catalogue withdrawal does not revoke an already retained funded obligation. */
  isCurrent(_original?: LCHOverlaySellerOriginal): boolean {
    return (
      this.pins.every(check => check()) &&
      this.ports.current() === true &&
      toHex(this.ports.sellerSigner.identityKey) === this.identity &&
      toHex(this.ports.issuerSigner.identityKey) === this.issuerIdentity
    )
  }
  private async terms(
    material: Material,
    signal: AbortSignal,
    verifier: LCHSignatureVerifier
  ): Promise<LCHOverlayPaidTerms> {
    this.check(signal)
    lchAssert(
      material.version === 1 && material.installation === this.installation,
      'ERR_LCH_LICENSE',
      'Retained seller installation differs'
    )
    const terms = await validateLCHOverlayPaidTerms({
      header: material.header,
      offer: material.offer,
      request: material.request,
      acquire: parse(material.acquire),
      selection: parse(material.selection),
      installedMechanisms: new Set(LCH_OVERLAY_PAID_MECHANISMS),
      maximumCiphertextBytes: this.ports.maximumCiphertextBytes,
      verifier,
      reader: new LCHReader(
        {
          read: async (...args) => {
            this.check(signal)
            const value = await this.ports.source.read(...args)
            this.check(signal)
            lchAssert(
              value.length <= this.ports.maximumCiphertextBytes,
              'ERR_LCH_CONTENT_UNAVAILABLE',
              'Seller ciphertext source exceeded bound'
            )
            return value
          }
        },
        undefined,
        { verifier }
      )
    })
    this.check(signal)
    lchAssert(
      terms.policy.seller === this.identity &&
        terms.offer.body.licenseIssuer instanceof Uint8Array &&
        toHex(terms.offer.body.licenseIssuer) === this.issuerIdentity,
      'ERR_LCH_AUTHORITY',
      'Seller or issuer differs from installation'
    )
    return terms
  }
  private material(encoded: string): Material {
    const data = Uint8Array.from(decodeOutputBytes(encoded, 4194304)),
      record = snapshotLCHRecord(decodeDeterministicCbor(data), 'Retained seller material'),
      value = record as unknown as Material
    lchAssert(
      Object.keys(record)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .join(',') ===
        'acquire,header,installation,keys,offer,paths,request,selectedAt,selection,version' &&
        value.version === 1 &&
        typeof value.installation === 'string' &&
        value.header instanceof Uint8Array &&
        value.request instanceof Uint8Array &&
        value.acquire instanceof Uint8Array &&
        value.selection instanceof Uint8Array &&
        Array.isArray(value.paths) &&
        value.paths.length <= 128 &&
        Array.isArray(value.keys) &&
        value.keys.length > 0 &&
        value.keys.length <= 256,
      'ERR_LCH_CBOR',
      'Retained seller material is incomplete or unsupported'
    )
    outputU64(value.selectedAt)
    lchAssert(
      toHex(encodeDeterministicCbor(value as unknown as LCHValue)) === toHex(data),
      'ERR_LCH_CBOR',
      'Retained seller material is not exact CBOR'
    )
    return value
  }
  private async validateKeys(
    material: Material,
    terms: LCHOverlayPaidTerms,
    signal: AbortSignal
  ): Promise<void> {
    const required = new Set(terms.encryption.keyPeriods.map(period => toHex(period.keyId)))
    lchAssert(
      material.keys.length === required.size,
      'ERR_LCH_KEY',
      'Retained whole-Asset key set differs'
    )
    await material.keys.reduce(
      (previous, grant) =>
        previous.then(async () => {
          this.check(signal)
          lchAssert(
            grant.keyId instanceof Uint8Array &&
              grant.keyId.length === 32 &&
              grant.cek instanceof Uint8Array &&
              grant.cek.length === 32 &&
              required.delete(toHex(grant.keyId)) &&
              toHex(await keyIdFor(grant.cek)) === toHex(grant.keyId),
            'ERR_LCH_KEY',
            'Retained CEK commitment differs'
          )
          this.check(signal)
        }),
      Promise.resolve()
    )
  }
  private async roles(
    material: Material,
    terms: LCHOverlayPaidTerms,
    at: string,
    verifier: LCHSignatureVerifier
  ): Promise<void> {
    await validateLCHOverlayPaidRoles(
      terms,
      material.paths,
      outputU64(at),
      this.ports.authorityNetwork,
      verifier,
      this.ports.revocations?.at(at)
    )
  }
  async prepare(
    request: OutputPaidLookupAcquire,
    selection: OutputCapabilitySelection,
    signal: AbortSignal
  ) {
    this.check(signal)
    request = parse(utf8(request))
    selection = parse(utf8(selection))
    const verifier = lchOverlaySignatureBudget(() => this.check(signal)),
      selectedAt = outputU64(this.ports.clock()).toString(),
      listing = await this.ports.catalogue.load(request, signal)
    this.check(signal)
    const retained = encodeDeterministicCbor({
      version: 1,
      installation: this.installation,
      selectedAt,
      header: listing.header,
      offer: listing.offer as unknown as LCHValue,
      request: Uint8Array.from(decodeOutputBytes(request.request, 2097152)),
      acquire: utf8(request),
      selection: utf8(selection),
      paths: (listing.authorityPaths ?? []) as unknown as LCHValue,
      keys: listing.keys.map(grant => ({
        keyId: snapshotBytes(grant.keyId, 'Seller Key ID'),
        cek: snapshotBytes(grant.cek, 'Seller CEK')
      }))
    })
    lchAssert(
      retained.length <= 4194304,
      'ERR_LCH_CBOR',
      'Complete retained seller material exceeds bound'
    )
    const evidenceSnapshot = parse<OutputEvidence>(utf8(listing.evidence)),
      verificationContext = parse<C>(utf8(listing.verificationContext)),
      material = this.material(Utils.toBase64(retained)),
      terms = await this.terms(material, signal, verifier)
    validateLCHOverlayPaidWindow(terms, null, selectedAt, terms.advertisedRecoverySeconds)
    await this.roles(material, terms, selectedAt, verifier)
    await this.validateKeys(material, terms, signal)
    const identity = await this.ports.issuerWallet.getPublicKey({ identityKey: true })
    this.check(signal)
    lchAssert(
      identity.publicKey === this.issuerIdentity,
      'ERR_LCH_KEY',
      'Issuer key-delivery wallet differs'
    )
    const agreement = await createLCHOverlayFixedRenderAgreement(terms.policy),
      evidence = await this.evidence(material),
      maximumContextBytes =
        393216 +
        encodeDeterministicCbor(evidence as unknown as LCHValue).length +
        (agreement.inline as Uint8Array).length +
        material.keys.length * 65536,
      cutoff = outputU64(selectedAt) + outputU64(this.ports.quoteSeconds),
      payableUntil =
        terms.notAfter !== undefined && cutoff > terms.notAfter ? terms.notAfter : cutoff,
      recovery = [86400n, terms.recoverySeconds, outputU64(terms.advertisedRecoverySeconds)].reduce(
        (a, b) => (a > b ? a : b),
        0n
      )
    // A representation placeholder checks the typed-object/signature inventory
    // before money. It is never used as settlement or a License.
    await encodeLCHOverlayContext(
      {
        version: 1,
        license: { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
        evidence,
        settlement: utf8({ version: 1 }),
        paymentEvidence: utf8({ version: 1 })
      },
      'paid-lookup'
    )
    lchAssert(
      maximumContextBytes <= 2097152 &&
        payableUntil > outputU64(selectedAt) &&
        evidenceSnapshot.txid === request.listing.txid &&
        evidenceSnapshot.outputIndex === request.listing.outputIndex,
      'ERR_LCH_LICENSE',
      'Quote listing, window or complete context reservation differs'
    )
    this.check(signal)
    return {
      terms: {
        satoshis: terms.policy.satoshis.toString(),
        derivationPrefix: this.ports.derivationPrefix(),
        payableUntil: payableUntil.toString(),
        creationCutoff: payableUntil.toString(),
        minimumRecoverySeconds: recovery.toString()
      },
      evidence: evidenceSnapshot,
      verificationContext,
      schema: LCH_OVERLAY_PROFILES.acquisition,
      maximumContextBytes,
      maximumAcceptanceBytes: 131072,
      material: Utils.toBase64(retained)
    }
  }
  /** Called after the coordinator's actual listing Script/SPV check. */
  async validate(
    request: OutputPaidLookupAcquire,
    preparation: { material: string; evidence: OutputEvidence; schema: string },
    signal: AbortSignal
  ): Promise<void> {
    request = parse(utf8(request))
    preparation = parse(utf8(preparation))
    const verifier = lchOverlaySignatureBudget(() => this.check(signal)),
      material = this.material(preparation.material),
      terms = await this.terms(material, signal, verifier)
    lchAssert(
      json(request) === json(terms.acquire) &&
        preparation.schema === LCH_OVERLAY_PROFILES.acquisition &&
        preparation.evidence.txid === request.listing.txid &&
        preparation.evidence.outputIndex === request.listing.outputIndex,
      'ERR_LCH_LICENSE',
      'Prepared LCH original differs'
    )
    await this.validateKeys(material, terms, signal)
    await this.roles(material, terms, this.ports.clock(), verifier)
    this.check(signal)
  }
  private async evidence(material: Material) {
    const objects = new Map<string, { type: 'offer' | 'authority'; object: SignedObject }>(),
      add = async (type: 'offer' | 'authority', object: SignedObject) => {
        const key = type + '\0' + toHex(await objectId(type, object.body))
        objects.set(key, { type, object })
      }
    await add('offer', material.offer)
    await material.paths.reduce(
      (previous, path) =>
        previous.then(() =>
          path.chain.reduce(
            (pending, authority) => pending.then(() => add('authority', authority)),
            Promise.resolve()
          )
        ),
      Promise.resolve()
    )
    return [...objects]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value)
  }
  async issue(
    original: LCHOverlaySellerOriginal,
    progress: LCHOverlaySellerProgress,
    encoded: string,
    signal: AbortSignal
  ): Promise<string> {
    this.check(signal)
    original = parse(utf8(original))
    progress = parse(utf8(progress))
    const verifier = lchOverlaySignatureBudget(() => this.check(signal)),
      material = this.material(encoded),
      terms = await this.terms(material, signal, verifier),
      selected = parse<OutputCapabilitySelection>(material.selection)
    lchAssert(
      json(original.request) === json(terms.acquire) &&
        original.schema === LCH_OVERLAY_PROFILES.acquisition &&
        json(original.challenge) === json(progress.challenge) &&
        outputU64(progress.recoveryUntil) >= outputU64(original.challenge.recoveryUntil) &&
        json(original.capability.manifest) === json(selected.manifest) &&
        original.capability.digest === selected.digest &&
        original.capability.service === terms.acquire.service &&
        original.capability.profile === selected.profile.id &&
        progress.phase === 'delivery-pending' &&
        progress.candidate?.verdict === 'accepted' &&
        progress.funding !== null &&
        progress.walletReceipt !== null &&
        progress.delivery !== null,
      'ERR_LCH_PAYMENT',
      'Issuance requires the exact retained accepted and credited obligation'
    )
    validateLCHOverlayPaidPromise(terms, original.challenge, terms.advertisedRecoverySeconds)
    const payment = progress.candidate!.payment,
      funding = progress.funding!,
      checked = await this.ports.verification.funding(
        payment,
        original.challenge,
        terms.acquire.listing.chain,
        signal
      )
    this.check(signal)
    lchAssert(
      json(checked.operation.funding) === json(funding.operation.funding) &&
        checked.operation.beef === funding.operation.beef &&
        checked.operation.beef === payment.transaction,
      'ERR_LCH_PAYMENT',
      'Retained seller funding differs'
    )
    await this.ports.verification.listing(original.evidence, terms.acquire.listing, signal)
    await this.ports.credited(funding.operation, progress.walletReceipt!.operationId, signal)
    this.check(signal)
    const assessment = await this.ports.verification.release(
      funding.acceptance,
      {
        chain: terms.acquire.listing.chain,
        txid: funding.operation.funding.txid,
        policy: original.challenge.acceptancePolicy
      },
      signal
    )
    assessment.checkCurrent()
    const issuedAt = outputU64(this.ports.clock()).toString()
    lchAssert(
      outputU64(issuedAt) >= outputU64(funding.acceptance.acceptedAt) &&
        outputU64(funding.acceptance.acceptedAt) >= outputU64(material.selectedAt),
      'ERR_LCH_PAYMENT',
      'Retained selection, acceptance and issuance chronology differs'
    )
    await [
      { actor: terms.binding.seller, capability: LCH_IRI + '#issueOffer', at: material.selectedAt },
      {
        actor: terms.binding.seller,
        capability: LCH_IRI + '#receivePayment',
        at: funding.acceptance.acceptedAt
      },
      {
        actor: this.ports.issuerSigner.identityKey,
        capability: LCH_IRI + '#issueLicense',
        at: issuedAt
      }
    ].reduce(
      (previous, role) =>
        previous.then(() =>
          validateLCHOverlayAuthority(
            terms,
            role.actor,
            role.capability,
            material.paths,
            outputU64(role.at),
            this.ports.authorityNetwork,
            verifier,
            this.ports.revocations?.at(role.at)
          )
        ),
      Promise.resolve()
    )
    await this.validateKeys(material, terms, signal)
    assessment.checkCurrent()
    this.check(signal)
    const body = {
        version: 1,
        seller: this.identity,
        buyer: original.request.recipient,
        requestId: original.request.requestId,
        offerId: original.request.termsDigest,
        assetId: original.request.assetId,
        dutyUid: terms.policy.dutyUid,
        acquisitionId: original.challenge.acquisitionId,
        funding: funding.operation.funding,
        satoshis: terms.policy.satoshis.toString(),
        acceptancePolicy: original.challenge.acceptancePolicy,
        releaseEvidenceDigest: outputPacketDigest('release-evidence', funding.acceptance),
        issuedAt,
        recoveryUntil: original.challenge.recoveryUntil
      },
      signature = await this.ports.sellerSigner.sign(
        Uint8Array.from(outputPacketPreimage('lch-lookup-settlement', body))
      ),
      settlement = { body, signature: Utils.toBase64(signature) },
      settlementId = outputPacketDigest('lch-lookup-settlement', body)
    this.check(signal)
    lchAssert(
      verifyOutputPacket('lch-lookup-settlement', settlement, this.identity),
      'ERR_LCH_SIGNATURE',
      'Seller settlement signature differs'
    )
    const grants: KeyGrant[] = []
    await material.keys.reduce(
      (previous, key) =>
        previous.then(async () => {
          const payload = await this.delivery.deliver(
            original.request.recipient,
            key.keyId,
            key.cek
          )
          lchAssert(
            toHex(payload.slice(4, 37)) === this.issuerIdentity,
            'ERR_LCH_KEY',
            'Key-delivery wallet sender changed'
          )
          grants.push({
            keyId: key.keyId,
            delivery: LCH_MECHANISMS.brc78Key,
            payload
          })
          this.check(signal)
          assessment.checkCurrent()
        }),
      Promise.resolve()
    )
    const agreement = await createLCHOverlayFixedRenderAgreement(terms.policy),
      license = await this.issuer.issueLicense({
        assetId: terms.inspected.assetId,
        offerId: bytes(original.request.termsDigest),
        requestId: bytes(original.request.requestId),
        issuer: this.ports.issuerSigner.identityKey,
        subject: terms.request.body.buyer as Uint8Array,
        issuedAt: outputU64(issuedAt),
        agreement,
        selection: { type: 'all' },
        keyGrants: grants,
        encryption: terms.encryption,
        fulfillments: [
          {
            dutyUid: terms.policy.dutyUid,
            settlementProfile: LCH_OVERLAY_PROFILES.paidSettlement,
            receiptIds: [bytes(settlementId)]
          }
        ],
        critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.paidSettlement],
        extensions: {
          [LCH_OVERLAY_PROFILES.acquisition]: {
            version: 1,
            mode: 'paid-lookup',
            settlementId: bytes(settlementId)
          },
          [LCH_OVERLAY_PROFILES.paidSettlement]: { version: 1 }
        }
      }),
      context = await encodeLCHOverlayContext(
        {
          version: 1,
          license,
          evidence: await this.evidence(material),
          settlement: utf8(settlement),
          paymentEvidence: utf8({
            version: 1,
            challenge: original.challenge,
            payment: {
              txid: funding.operation.funding.txid,
              outputIndex: funding.operation.funding.outputIndex,
              beef: payment.transaction
            },
            release: funding.acceptance,
            derivationSuffix: payment.derivationSuffix
          })
        },
        'paid-lookup'
      )
    await verifySignedObject('license', license, verifier, this.ports.issuerSigner.identityKey, {
      supportedCriticalIdentifiers: new Set([
        LCH_OVERLAY_PROFILES.acquisition,
        LCH_OVERLAY_PROFILES.paidSettlement
      ])
    })
    assessment.checkCurrent()
    this.check(signal)
    return Utils.toBase64(context)
  }
}
function pin<T extends object>(owner: T, key: keyof T): () => boolean {
  const method = owner[key]
  return () => owner[key] === method
}
