import {
  parseOutputEvidence,
  parseOutputPurchaseEnvelope,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import type { RevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { lchAssert } from './errors.js'
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
> {}
export interface LCHOverlayCovenantProfileDomainOptions extends LCHCovenantDomainOptions<
  RevenueListingProfileDescriptor,
  LCHOverlayCovenantProfilePreparation,
  LCHOverlayCovenantProfileOriginalPurchase
> {}
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
  private constructor(options: LCHOverlayCovenantProfileDomainOptions, retained?: Uint8Array) {
    super(options, current, retained)
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
