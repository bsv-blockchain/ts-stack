import {
  parseOutputEvidence,
  parseOutputPurchaseEnvelope,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import type { RevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { lchAssert } from './errors.js'
import type { LCHOverlayVerifiedCovenantPurchase } from './overlayAcquisitionCovenantProof.js'
import { toHex } from './hash.js'
import { validateLCHCollectorPreparation } from './overlayAcquisitionCollectorProfile.js'
import {
  LCHCovenantDomainCore,
  type LCHCovenantAssessment,
  type LCHCovenantDomainOptions,
  type LCHCovenantDomainProfile,
  type LCHCovenantOriginalPurchase,
  type LCHCovenantVerification
} from './overlayAcquisitionCovenantCore.js'
import {
  bindLCHOverlayCovenantProfileSettlement,
  decodeLCHOverlayCovenantProfilePurchaseEvidence
} from './overlayAcquisitionCovenantProfileSettlement.js'
import {
  validateLCHOverlayCovenantProfileTerms,
  validateLCHOverlayCovenantProfilePromise,
  validateLCHOverlayCovenantProfileWindow
} from './overlayAcquisitionCovenantProfileTerms.js'
import type { LCHOverlayObjectCustody } from './overlayAcquisitionCustody.js'

/** Owned data from the independently installed complete-history/current-chain
 * verifier. Its synchronous guard binds stage and height to that exact view. */
export interface LCHOverlayCovenantProfilePreparation extends LCHCovenantAssessment {
  stage: 'activation' | 'active'
  currentHeight: string
}
export interface LCHOverlayCovenantProfileOriginalPurchase extends LCHCovenantOriginalPurchase {
  /** The complete original funded wallet subject. Verify every actual input
   * and its original association, then independently verify the released alias
   * and require the identical full purchase commitment before returning success. */
  candidate: OutputEvidence
}
export interface LCHOverlayCovenantProfileVerification extends LCHCovenantVerification<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation,
  LCHOverlayCovenantProfileOriginalPurchase
> {
  /** Explicit complete candidate verifier, independent of private delivery.
   * Execute Bitcoin/Script, complete listing lineage, signed preparation and
   * every actual input association before returning the full commitment. Its
   * guard binds the same selected verification context; a digest is no proof.
   * Omission preserves the historical installation and exposes no binding hook. */
  candidate?(
    candidate: OutputEvidence,
    original: LCHOverlayCovenantProfileOriginalPurchase,
    signal: AbortSignal
  ): Promise<LCHOverlayVerifiedCovenantPurchase>
}
export interface LCHOverlayCovenantProfileDomainOptions extends LCHCovenantDomainOptions<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation,
  LCHOverlayCovenantProfileOriginalPurchase
> {
  verification: LCHOverlayCovenantProfileVerification
}
function ownPreparation(
  descriptor: RevenueListingProfileDescriptor,
  assessment: LCHOverlayCovenantProfilePreparation
): () => void {
  const stage = Object.getOwnPropertyDescriptor(assessment, 'stage')?.value as unknown,
    height = Object.getOwnPropertyDescriptor(assessment, 'currentHeight')?.value as unknown
  lchAssert(
    (stage === 'activation' || stage === 'active') && typeof height === 'string',
    'ERR_LCH_LICENSE',
    'Current preparation requires owned stage and installed chain height'
  )
  return () => {
    lchAssert(
      Object.getOwnPropertyDescriptor(assessment, 'stage')?.value === stage &&
        Object.getOwnPropertyDescriptor(assessment, 'currentHeight')?.value === height,
      'ERR_LCH_LICENSE',
      'Current preparation assessment changed'
    )
    validateLCHCollectorPreparation(descriptor, stage, height)
  }
}
const current: LCHCovenantDomainProfile<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation,
  LCHOverlayCovenantProfileOriginalPurchase
> = {
  adapter: 'immutable-standing-collector/1',
  terms: validateLCHOverlayCovenantProfileTerms,
  window: validateLCHOverlayCovenantProfileWindow,
  preparation: (terms, assessment, challenge, clock) => {
    const check = ownPreparation(terms.descriptor, assessment)
    return () => {
      check()
      validateLCHOverlayCovenantProfileWindow(terms, challenge, clock())
    }
  },
  evidence: decodeLCHOverlayCovenantProfilePurchaseEvidence,
  bind: bindLCHOverlayCovenantProfileSettlement,
  subject: (_candidate, delivered) => {
    const envelope = parseOutputPurchaseEnvelope(delivered)
    lchAssert(
      envelope.result.status === 'delivered',
      'ERR_LCH_LICENSE',
      'Complete current delivery is required'
    )
    return envelope.result.txid
  },
  original: (input, candidate) => ({ ...input, candidate: parseOutputEvidence(candidate) })
}
/** Optional current immutable C buyer. Creating it performs no financial work.
 * Its distinct installation identity never reinterprets retained historical
 * domain data. Independent full purchase/alias/release and License checks remain
 * mandatory; current-alias transport fields alone grant no rights. */
export class LCHOverlayCovenantProfileDomain extends LCHCovenantDomainCore<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation,
  LCHOverlayCovenantProfileOriginalPurchase
> {
  /** Present only when complete candidate verification was explicitly installed
   * before creation or reopen. A full-commitment buyer can refuse a missing
   * capability before preparation or finance. No private release is fabricated. */
  readonly candidateBinding?: (
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit,
    signal: AbortSignal
  ) => Promise<LCHOverlayVerifiedCovenantPurchase>
  private constructor(options: LCHOverlayCovenantProfileDomainOptions, retained?: Uint8Array) {
    super(
      options,
      options.verification.candidate === undefined
        ? current
        : { ...current, adapter: 'immutable-standing-collector-full-commitment/1' },
      retained
    )
    const candidate = options.verification.candidate,
      owner = options.verification,
      checkInstalled = () => {
        lchAssert(
          options.verification === owner && owner.candidate === candidate,
          'ERR_LCH_LICENSE',
          'Installed complete candidate verifier changed'
        )
      }
    if (candidate !== undefined) {
      lchAssert(
        typeof candidate === 'function',
        'ERR_LCH_PROFILE_UNSUPPORTED',
        'Complete candidate verifier must be installed explicitly'
      )
      this.candidateBinding = (request, challenge, value, signal) =>
        this.candidateBindingCore(
          request,
          challenge,
          value,
          async (terms, original, signal) => {
            checkInstalled()
            validateLCHOverlayCovenantProfilePromise(terms, original.terms)
            const verified = await candidate.call(owner, original.candidate, original, signal)
            checkInstalled()
            return verified
          },
          checkInstalled,
          signal
        )
    }
  }
  static async create(
    options: LCHOverlayCovenantProfileDomainOptions
  ): Promise<LCHOverlayCovenantProfileDomain> {
    const domain = new LCHOverlayCovenantProfileDomain(options)
    await domain.preflightTerms(options.original.prepare, null, new AbortController().signal)
    return domain
  }
  /** Retain and recheck the returned same-view fence immediately before any
   * financial reservation/action. Initial unsigned catalogue work cannot call
   * this boundary without a complete original signed preparation promise. */
  async fundingPreflight(
    request: OutputPurchasePrepare,
    challenge: OutputSignedPurchaseTerms,
    signal: AbortSignal
  ): Promise<LCHCovenantAssessment> {
    lchAssert(
      challenge !== null && challenge !== undefined,
      'ERR_LCH_QUOTE',
      'Signed preparation is required before funding'
    )
    return this.fundingPreflightCore(request, challenge, signal)
  }
  /** Read-only historical reopen: no new height/time funding predicate. */
  static async open(
    options: LCHOverlayCovenantProfileDomainOptions,
    retained: { id: string; original: Uint8Array },
    objects: LCHOverlayObjectCustody
  ): Promise<LCHOverlayCovenantProfileDomain> {
    const original = retained.original.slice(),
      domain = new LCHOverlayCovenantProfileDomain(options, original)
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
