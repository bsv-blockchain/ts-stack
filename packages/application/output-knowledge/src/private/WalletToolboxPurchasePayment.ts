import { type OutputSignedPurchaseTerms, type Transaction } from '@bsv/sdk'
import {
  RevenueListing,
  REVENUE_LISTING_PROGRAM_SHA256,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { RevenueListingLineageVerifier } from '../revenue-listing/RevenueListingLineageVerifier.js'
import {
  parseRevenueListingLineagePackage,
  type RevenueListingLineagePackage
} from '../revenue-listing/LineagePackage.js'
import {
  WalletToolboxPurchasePaymentCore,
  type WalletToolboxPurchasePaymentCoreOptions,
  type PurchaseWalletSpend
} from './WalletToolboxPurchasePaymentCore.js'
export interface WalletToolboxPurchasePaymentOptions extends WalletToolboxPurchasePaymentCoreOptions {
  family: RevenueListing
}
/** Historical single-program noSend purchase adapter. Public options, format-one
 * stored plans and native intent/layout/recovery behavior are retained. Select
 * WalletToolboxProfilePurchasePayment for the current two-stage exemplar. */
export class WalletToolboxPurchasePayment extends WalletToolboxPurchasePaymentCore<RevenueListingDescriptor> {
  constructor(ports: WalletToolboxPurchasePaymentOptions) {
    super(
      ports,
      Object.freeze({
        format: 'private-purchase-wallet/1' as const,
        script: REVENUE_LISTING_PROGRAM_SHA256,
        parse: parseRevenueListingLineagePackage,
        verifier: () => new RevenueListingLineageVerifier(ports.family, ports.chains),
        eligible: () => {},
        spend: (
          lineage: RevenueListingLineagePackage,
          predecessor: Transaction,
          terms: OutputSignedPurchaseTerms
        ): PurchaseWalletSpend => {
          const spend = new RevenueListingSpend(
            ports.family,
            lineage.descriptor,
            [{ rawTransaction: predecessor.toHex(), outputIndex: lineage.target.outputIndex }],
            {
              operation: 'purchase',
              acquisitionId: terms.body.acquisitionId,
              requestDigest: terms.body.requestDigest,
              recipient: terms.body.recipient
            }
          )
          return {
            plan: () => spend.plan(),
            estimateUnlockingLength: index => spend.estimateUnlockingLength(index),
            prepare: transaction => {
              const prepared = spend.prepare(transaction)
              return {
                signingRequests: () => prepared.signingRequests(),
                complete: () =>
                  prepared.complete(spend.plan().inputs.map(() => ({ recipients: [] }))),
                assertFinalLayout: transaction => prepared.assertFinalLayout(transaction)
              }
            }
          }
        }
      })
    )
  }
}
