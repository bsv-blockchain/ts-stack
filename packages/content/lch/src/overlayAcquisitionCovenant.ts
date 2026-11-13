import {
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms,
  type OutputReleaseEvidence,
  type OutputReleaseBinding,
  type WalletInterface
} from '@bsv/sdk'
import type { RevenueListingDescriptor } from '@bsv/sdk/script/templates/RevenueListing'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'
import {
  LCHCovenantDomainCore,
  type LCHCovenantDomainProfile,
  type LCHCovenantAssessment,
  type LCHCovenantOriginalPurchase
} from './overlayAcquisitionCovenantCore.js'
import {
  bindLCHOverlayCovenantSettlement,
  decodeLCHOverlayCovenantPurchaseEvidence,
  type LCHOverlayCovenantPurchaseEvidence
} from './overlayAcquisitionCovenantSettlement.js'
import {
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantWindow,
  type LCHOverlayCovenantTerms,
  type LCHOverlayCovenantTermsInput
} from './overlayAcquisitionCovenantTerms.js'
import type { LCHOverlayVerifiedCovenantPurchase } from './overlayAcquisitionCovenantProof.js'
import type { LCHOverlayObjectCustody } from './overlayAcquisitionCustody.js'
import type { LCHOverlayAuthorityPath } from './overlayAcquisitionAuthority.js'
import type { ContentSource, RevocationObservation, RevocationSource } from './types.js'

/** Installed historical-family and release proof boundaries. Remote packets
 * and collector signatures cannot implement these locally selected verifiers.
 * Current BRC-197 installations use LCHOverlayCovenantProfileVerification.
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
  ): Promise<LCHOverlayVerifiedCovenantPurchase>
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

const historical: LCHCovenantDomainProfile<
  RevenueListingDescriptor,
  LCHCovenantAssessment,
  LCHCovenantOriginalPurchase
> = {
  adapter: 'fixed-render-standing-collector/1',
  terms: validateLCHOverlayCovenantTerms,
  window: validateLCHOverlayCovenantWindow,
  preparation: () => () => undefined,
  evidence: decodeLCHOverlayCovenantPurchaseEvidence,
  bind: bindLCHOverlayCovenantSettlement,
  subject: candidate => candidate.txid,
  original: input => input
}
/** Historical covenant domain retained with its original public interfaces,
 * installation identity, protected custody and independent verification checks. */
export class LCHOverlayCovenantDomain extends LCHCovenantDomainCore<
  RevenueListingDescriptor,
  LCHCovenantAssessment,
  LCHCovenantOriginalPurchase
> {
  private constructor(options: LCHOverlayCovenantDomainOptions, retained?: Uint8Array) {
    super(options, historical, retained)
  }
  static async create(options: LCHOverlayCovenantDomainOptions): Promise<LCHOverlayCovenantDomain> {
    const domain = new LCHOverlayCovenantDomain(options)
    await domain.preflightTerms(options.original.prepare, null, new AbortController().signal)
    return domain
  }
  /** Read-only reopen; retained obligations never become new acquisitions. */
  static async open(
    options: LCHOverlayCovenantDomainOptions,
    retained: { id: string; original: Uint8Array },
    objects: LCHOverlayObjectCustody
  ): Promise<LCHOverlayCovenantDomain> {
    const original = retained.original.slice(),
      domain = new LCHOverlayCovenantDomain(options, original)
    lchAssert(
      domain.id === retained.id && toHex(domain.original()) === toHex(original),
      'ERR_LCH_LICENSE',
      'Retained LCH domain installation differs'
    )
    await domain.attachCustody(objects, false)
    await domain.terms(new AbortController().signal)
    return domain
  }
}
