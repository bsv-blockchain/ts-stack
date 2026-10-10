import type {
  OutputEvidence,
  OutputPurchasePrepare,
  OutputReleaseBinding,
  OutputReleaseEvidence,
  OutputRetainedCapability,
  OutputSignedPurchaseTerms,
  WalletInterface
} from '@bsv/sdk'
import {
  revenueListingId,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import type { LCHOverlayVerifiedCovenantPurchase } from './overlayAcquisitionCovenantProof.js'
import type { LCHOverlayAuthorityPath } from './overlayAcquisitionAuthority.js'
import type { LCHOverlayCovenantLineage } from './overlayAcquisitionCovenantSettlement.js'
import {
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantPromise,
  validateLCHOverlayCovenantWindow
} from './overlayAcquisitionCovenantTerms.js'
import {
  LCHCovenantSellerCore,
  type LCHCovenantSellerProfile
} from './overlayAcquisitionCovenantSellerCore.js'
import type { LCHCovenantAssessment } from './overlayAcquisitionCovenantCore.js'
import type {
  ContentSource,
  LCHSigner,
  RevocationObservation,
  RevocationSource,
  SignedObject
} from './types.js'
export interface LCHOverlayCovenantSellerListing {
  header: Uint8Array
  offer: SignedObject
  descriptor: RevenueListingDescriptor
  lineage: LCHOverlayCovenantLineage
  keys: readonly { keyId: Uint8Array; cek: Uint8Array }[]
  authorityPaths?: readonly LCHOverlayAuthorityPath[]
}
/** These installed ports execute full lineage/Script and release checks. No
 * catalogue field, wire signature or admission status implements them.
 */
export interface LCHOverlayCovenantSellerVerification {
  readonly id: string
  lineage(
    lineage: LCHOverlayCovenantLineage,
    expected: { request: OutputPurchasePrepare; descriptor: RevenueListingDescriptor },
    signal: AbortSignal
  ): Promise<{ checkCurrent(): void }>
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
export interface LCHOverlayCovenantSellerOptions {
  id: string
  catalogue: {
    load(
      request: OutputPurchasePrepare,
      signal: AbortSignal
    ): Promise<LCHOverlayCovenantSellerListing>
  }
  source: ContentSource
  sellerSigner: LCHSigner
  issuerSigner: LCHSigner
  issuerWallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>
  verification: LCHOverlayCovenantSellerVerification
  authorityNetwork: RevocationObservation['network']
  revocations?: { readonly id: string; at(time: string): RevocationSource }
  maximumCiphertextBytes: number
  purchaseSeconds: string
  clock(): string
  current(): boolean
}
/** Structural coordinator port types keep this optional package independent
 * of Node/native persistence. The coordinator owns and parses these records.
 */
export interface LCHOverlayCovenantSellerCustody {
  original: {
    request: OutputPurchasePrepare
    terms: OutputSignedPurchaseTerms
    capability: OutputRetainedCapability
    createdAt: string
  }
  schema: string
  maximumSecretBytes: number
  material: string
}
export interface LCHOverlayCovenantSellerProgress {
  status: string
  txid: string | null
  admission: { acceptedAt: string } | null
  recoveryUntil: string
}

const historical: LCHCovenantSellerProfile<RevenueListingDescriptor, LCHCovenantAssessment> = {
  adapter: 'fixed-render-standing-collector/1',
  terms: validateLCHOverlayCovenantTerms,
  promise: validateLCHOverlayCovenantPromise,
  window: validateLCHOverlayCovenantWindow,
  listingId: revenueListingId,
  preparation: () => () => undefined
}
/** Preserved historical seller, including original interfaces, installation identity,
 * protected material, complete proof/role/key and issuance behavior. */
export class LCHOverlayCovenantSeller extends LCHCovenantSellerCore<
  RevenueListingDescriptor,
  LCHCovenantAssessment
> {
  constructor(options: LCHOverlayCovenantSellerOptions) {
    super(options, historical)
  }
}
